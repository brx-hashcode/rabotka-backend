import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { InterestClusterService } from './interest-cluster.service';

const EXPLOIT_RATIO = 0.7;
const DEFAULT_LIMIT = 10;
const MIN_SIGNALS_FOR_PERSONALIZATION = 3;

// How many candidate explore jobs to fetch before sampling
const EXPLORE_POOL_FACTOR = 5;

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

    if (!profile || profile.totalSignals < MIN_SIGNALS_FOR_PERSONALIZATION) {
      return this.fallback(workerId, limit);
    }

    const exploitCount = Math.round(limit * EXPLOIT_RATIO);
    const exploreCount = limit - exploitCount;

    const [exploited, explored] = await Promise.all([
      this.exploit(
        workerId,
        profile.positiveVectors,
        profile.negativeVectors,
        exploitCount,
      ),
      this.explore(
        workerId,
        profile.positiveVectors,
        profile.categories,
        exploreCount,
      ),
    ]);

    const seen = new Set<string>();
    const results: RecommendedJob[] = [];

    for (const r of exploited) {
      if (!seen.has(r.jobId)) {
        seen.add(r.jobId);
        results.push(r);
      }
    }

    for (const r of explored) {
      if (!seen.has(r.jobId)) {
        seen.add(r.jobId);
        results.push(r);
      }
    }

    // If exploit returned fewer than expected, fill from fallback
    if (results.length < limit) {
      const gap = limit - results.length;
      const extra = await this.fallback(workerId, gap * 2);
      for (const r of extra) {
        if (!seen.has(r.jobId)) {
          seen.add(r.jobId);
          results.push(r);
          if (results.length >= limit) break;
        }
      }
    }

    return results.slice(0, limit);
  }

  // ── 70% Exploit ───────────────────────────────────────────────────────────

  private async exploit(
    workerId: string,
    positiveVectors: number[][],
    negativeVectors: number[][],
    limit: number,
  ): Promise<RecommendedJob[]> {
    if (!positiveVectors.length) return [];

    const filter = this.buildJobFilter(workerId);

    try {
      const results = await this.qdrant.recommendDense(
        COLLECTIONS.JOBS,
        positiveVectors,
        negativeVectors,
        filter,
        limit,
      );

      return results.map((r) => ({
        jobId: r.id as string,
        score: r.score,
        source: 'interest' as const,
      }));
    } catch (err) {
      this.logger.warn('Qdrant recommend() failed, continuing with fallback', err);
      return [];
    }
  }

  // ── 30% Explore — semantically adjacent, not random ───────────────────────

  private async explore(
    workerId: string,
    positiveVectors: number[][],
    knownCategories: string[],
    limit: number,
  ): Promise<RecommendedJob[]> {
    if (!limit) return [];

    // No positive vectors yet → pure DB sample from unknown categories
    if (!positiveVectors.length) {
      return this.exploreByDb(workerId, knownCategories, limit);
    }

    // Use a blended positive medoid to find jobs in semantically adjacent space
    // but exclude jobs in categories the worker has already seen
    const blendedVector = blendVectors(positiveVectors);
    const filter = this.buildJobFilter(workerId, knownCategories);

    try {
      const results = await this.qdrant.recommendDense(
        COLLECTIONS.JOBS,
        [blendedVector],
        [], // no negatives in explore — we want adjacent, not repelled
        filter,
        limit * EXPLORE_POOL_FACTOR,
      );

      // Shuffle the pool so explore doesn't always return the same top-N
      const shuffled = results
        .sort(() => Math.random() - 0.5)
        .slice(0, limit);

      return shuffled.map((r) => ({
        jobId: r.id as string,
        score: r.score,
        source: 'explore' as const,
      }));
    } catch {
      return this.exploreByDb(workerId, knownCategories, limit);
    }
  }

  // Fallback explore when Qdrant isn't available
  private async exploreByDb(
    workerId: string,
    knownCategories: string[],
    limit: number,
  ): Promise<RecommendedJob[]> {
    const jobs = await this.prisma.jobOffer.findMany({
      where: {
        status: 'ACTIVE',
        applications: { none: { worker_id: workerId } },
        ...(knownCategories.length > 0
          ? { category: { name: { notIn: knownCategories } } }
          : {}),
      },
      select: { id: true },
      take: limit * EXPLORE_POOL_FACTOR,
      orderBy: { created_at: 'desc' },
    });

    return jobs
      .sort(() => Math.random() - 0.5)
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

    const filter = this.buildJobFilter(workerId);

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
    workerId: string,
    excludeCategories?: string[],
  ): Record<string, unknown> {
    const must: unknown[] = [
      { key: 'status', match: { value: 'ACTIVE' } },
    ];
    const must_not: unknown[] = [
      { key: 'applied_worker_ids', match: { any: [workerId] } },
    ];

    if (excludeCategories?.length) {
      must_not.push(
        ...excludeCategories.map((cat) => ({
          key: 'category_name',
          match: { value: cat },
        })),
      );
    }

    return { must, must_not };
  }
}

// ── Pure math helpers ─────────────────────────────────────────────────────────

function blendVectors(vectors: number[][]): number[] {
  const dim = vectors[0]?.length ?? 384;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i]!;
    }
  }
  return sum.map((v) => v / vectors.length);
}
