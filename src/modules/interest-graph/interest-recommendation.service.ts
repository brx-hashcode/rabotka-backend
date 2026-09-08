import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { InterestClusterService } from './interest-cluster.service';
import {
  haversineKm,
  proximityScore,
  urgencyScore,
  URGENCY_HALF_LIFE_HOURS,
} from '../../common/services/geocoding/geo.utils';
import type { Coordinates } from '../../common/services/geocoding/geocoding.service';

const DEFAULT_LIMIT = 10;

// Cold  (0)      → attribute-only fallback (profile text hybrid search)
// Warm  (1–4)    → 40% vector exploit + 60% fallback
// Hot   (5+)     → 70% exploit + 30% explore
const WARM_THRESHOLD = 1;
const HOT_THRESHOLD = 5;
const HOT_EXPLOIT_RATIO = 0.7;
const WARM_EXPLOIT_RATIO = 0.4;

// How many candidate explore jobs to fetch before sampling
const EXPLORE_POOL_FACTOR = 5;
// Minimum Qdrant prefetch regardless of requested limit
const MIN_PREFETCH = 20;

export interface RecommendedJob {
  jobId: string;
  score: number;
  source: 'interest' | 'explore' | 'fallback';
}

@Injectable()
export class InterestRecommendationService {
  private readonly logger = new Logger(InterestRecommendationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly clusters: InterestClusterService,
  ) {}

  async recommend(
    workerId: string,
    limit = DEFAULT_LIMIT,
  ): Promise<RecommendedJob[]> {
    const profile = await this.clusters.getProfile(workerId);
    const signals = profile?.totalSignals ?? 0;

    // Cold start — no signals yet, pure profile-text search
    if (signals < WARM_THRESHOLD || !profile) {
      if (!profile) {
        void this.clusters.ensureSeeded(workerId).catch(() => undefined);
      }
      return this.fallback(workerId, limit);
    }

    const exploitRatio =
      signals >= HOT_THRESHOLD ? HOT_EXPLOIT_RATIO : WARM_EXPLOIT_RATIO;
    const exploitCount = Math.round(limit * exploitRatio);
    const exploreCount = limit - exploitCount;

    const [exploited, explored, fallbackResults] = await Promise.all([
      this.exploit(
        workerId,
        profile.positiveVectors,
        profile.negativeVectors,
        profile.seenJobIds,
        exploitCount,
      ),
      exploreCount > 0
        ? this.explore(
            workerId,
            profile.positiveVectors,
            profile.categories,
            profile.seenJobIds,
            exploreCount,
            limit,
          )
        : Promise.resolve([]),
      this.fallback(workerId, limit),
    ]);

    const seen = new Set<string>();
    const results: RecommendedJob[] = [];

    mergeUnique(exploited, seen, results);
    mergeUnique(explored, seen, results);
    mergeUnique(fallbackResults, seen, results, limit);

    const merged = results.slice(0, limit);
    return this.rerank(workerId, merged);
  }

  // ── Re-ranking: combine qdrant score + proximity + urgency ────────────────

  private async rerank(
    workerId: string,
    results: RecommendedJob[],
  ): Promise<RecommendedJob[]> {
    if (results.length === 0) return results;

    const [workerRow, offerRows] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: workerId },
        select: { latitude: true, longitude: true },
      }),
      this.prisma.jobOffer.findMany({
        where: { id: { in: results.map((r) => r.jobId) } },
        select: {
          id: true,
          latitude: true,
          longitude: true,
          scheduled_at: true,
        },
      }),
    ]);

    const workerCoords: Coordinates | null =
      workerRow?.latitude != null && workerRow.longitude != null
        ? { lat: workerRow.latitude, lng: workerRow.longitude }
        : null;

    const offerMap = new Map(offerRows.map((o) => [o.id, o]));

    // Normalize qdrant scores to [0, 1] using min-max
    const scores = results.map((r) => r.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const scoreRange = maxScore - minScore || 1;

    // One clock for the whole pass — see `freshnessScore` in the recommendation
    // engine's `scoring.ts`.
    const now = Date.now();

    const ranked = results.map((r) => {
      const offer = offerMap.get(r.jobId);
      const normalizedQdrant = (r.score - minScore) / scoreRange;

      const prox =
        workerCoords != null &&
        offer?.latitude != null &&
        offer?.longitude != null
          ? proximityScore(
              haversineKm(workerCoords, {
                lat: offer.latitude,
                lng: offer.longitude,
              }),
            )
          : 0.5; // neutral when coords unavailable

      const urgency = offer?.scheduled_at
        ? urgencyScore(offer.scheduled_at, URGENCY_HALF_LIFE_HOURS, now)
        : 0.5;

      const combined = 0.5 * normalizedQdrant + 0.3 * prox + 0.2 * urgency;
      return { ...r, score: combined };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }

  // ── 70% Exploit ───────────────────────────────────────────────────────────

  private async exploit(
    workerId: string,
    positiveVectors: number[][],
    negativeVectors: number[][],
    seenJobIds: string[],
    limit: number,
  ): Promise<RecommendedJob[]> {
    if (!positiveVectors.length) return [];

    const filter = this.buildJobFilter(seenJobIds);

    try {
      const results = await this.qdrant.recommendDense(
        COLLECTIONS.JOBS,
        positiveVectors,
        negativeVectors,
        filter,
        limit,
      );

      this.logger.debug(
        `exploit() returned ${results.length} results for user=${workerId}`,
      );

      return results.map((r) => ({
        jobId: r.id as string,
        score: r.score,
        source: 'interest' as const,
      }));
    } catch (err) {
      this.logger.warn(
        'Qdrant recommend() failed, continuing with fallback',
        err,
      );
      return [];
    }
  }

  // ── 30% Explore — semantically adjacent, not random ───────────────────────

  private async explore(
    workerId: string,
    positiveVectors: number[][],
    knownCategories: string[],
    seenJobIds: string[],
    limit: number,
    requestedLimit: number,
  ): Promise<RecommendedJob[]> {
    if (!limit) return [];

    // No positive vectors yet → pure DB sample from unknown categories
    if (!positiveVectors.length) {
      return this.exploreByDb(workerId, knownCategories, seenJobIds, limit);
    }

    // Use a blended positive medoid to find jobs in semantically adjacent space
    // but exclude jobs in categories the worker has already seen
    const blendedVector = blendVectors(positiveVectors);
    const filter = this.buildJobFilter(seenJobIds, knownCategories);
    // Dynamic prefetch: proportional to requested limit, avoids over-fetching
    const poolSize = Math.max(
      requestedLimit * EXPLORE_POOL_FACTOR,
      MIN_PREFETCH,
    );

    try {
      const results = await this.qdrant.recommendDense(
        COLLECTIONS.JOBS,
        [blendedVector],
        [], // no negatives in explore — we want adjacent, not repelled
        filter,
        poolSize,
      );

      // Shuffle the pool so explore doesn't always return the same top-N
      const shuffled = results
        .toSorted(() => Math.random() - 0.5)
        .slice(0, limit);

      this.logger.debug(
        `explore() returned ${shuffled.length} results for user=${workerId} (pool=${results.length})`,
      );

      return shuffled.map((r) => ({
        jobId: r.id as string,
        score: r.score,
        source: 'explore' as const,
      }));
    } catch {
      return this.exploreByDb(workerId, knownCategories, seenJobIds, limit);
    }
  }

  // Fallback explore when Qdrant isn't available
  private async exploreByDb(
    workerId: string,
    knownCategories: string[],
    seenJobIds: string[],
    limit: number,
  ): Promise<RecommendedJob[]> {
    const jobs = await this.prisma.jobOffer.findMany({
      where: {
        status: 'ACTIVE',
        applications: { none: { worker_id: workerId } },
        ...(seenJobIds.length > 0 ? { id: { notIn: seenJobIds } } : {}),
        ...(knownCategories.length > 0
          ? { category: { name: { notIn: knownCategories } } }
          : {}),
      },
      select: { id: true },
      take: limit * EXPLORE_POOL_FACTOR,
      orderBy: { created_at: 'desc' },
    });

    return jobs
      .toSorted(() => Math.random() - 0.5)
      .slice(0, limit)
      .map((j) => ({ jobId: j.id, score: 0, source: 'explore' as const }));
  }

  // ── Cold-start fallback ────────────────────────────────────────────────────

  private async fallback(
    workerId: string,
    limit: number,
  ): Promise<RecommendedJob[]> {
    const worker = await this.prisma.profile.findUnique({
      where: { id: workerId },
      select: {
        description: true,
        category: { select: { name: true } },
        categories: { select: { category: { select: { name: true } } } },
      },
    });
    if (!worker) return [];

    const primaryCat = worker.category?.name ?? '';
    const extraCats = worker.categories.map((pc) => pc.category.name);
    const queryText = [primaryCat, ...extraCats, worker.description]
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);

    if (!queryText) return [];

    const filter = this.buildJobFilter([]);

    try {
      const results = await this.qdrant.searchHybridWithFilter(
        COLLECTIONS.JOBS,
        queryText,
        filter,
        limit,
      );
      return results.map((r) => ({
        jobId: r.id as string,
        score: r.score,
        source: 'fallback' as const,
      }));
    } catch {
      return [];
    }
  }

  // ── Shared filter builder ─────────────────────────────────────────────────

  private buildJobFilter(
    seenJobIds: string[],
    excludeCategories?: string[],
  ): Record<string, unknown> {
    const must: unknown[] = [{ key: 'status', match: { value: 'ACTIVE' } }];
    const must_not: unknown[] = [];

    // Exclude jobs the user has already seen/interacted with
    if (seenJobIds.length) {
      must_not.push({ key: 'jobOfferId', match: { any: seenJobIds } });
    }

    // Exclude known categories (explore phase diversity)
    if (excludeCategories?.length) {
      must_not.push({ key: 'categoryName', match: { any: excludeCategories } });
    }

    return must_not.length ? { must, must_not } : { must };
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function mergeUnique(
  items: RecommendedJob[],
  seen: Set<string>,
  out: RecommendedJob[],
  cap?: number,
): void {
  for (const r of items) {
    if (seen.has(r.jobId)) continue;
    seen.add(r.jobId);
    out.push(r);
    if (cap !== undefined && out.length >= cap) break;
  }
}

// ── Pure math helpers ─────────────────────────────────────────────────────────

function blendVectors(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 384;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i];
    }
  }
  return sum.map((v) => v / vectors.length);
}
