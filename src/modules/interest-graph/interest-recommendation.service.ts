import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { InterestClusterService } from './interest-cluster.service';

const EXPLOIT_RATIO = 0.7;
const DEFAULT_LIMIT = 10;
const MIN_SIGNALS_FOR_PERSONALIZATION = 3;

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
    private readonly matching: MatchingService,
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
      this.explore(workerId, profile.categories, exploreCount),
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

    return results.slice(0, limit);
  }

  private async exploit(
    workerId: string,
    positiveVectors: number[][],
    negativeVectors: number[][],
    limit: number,
  ): Promise<RecommendedJob[]> {
    if (!positiveVectors.length) return [];

    const filter = {
      must: [
        { key: 'status', match: { value: 'OPEN' } },
        { key: 'is_deleted', match: { value: false } },
      ],
      must_not: [{ key: 'applied_worker_ids', match: { any: [workerId] } }],
    };

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
      this.logger.warn('Qdrant recommend failed, falling back', err);
      return [];
    }
  }

  private async explore(
    workerId: string,
    knownCategories: string[],
    limit: number,
  ): Promise<RecommendedJob[]> {
    if (!limit) return [];

    // Pick random OPEN jobs from unexplored categories
    const unexploredJobs = await this.prisma.jobOffer.findMany({
      where: {
        status: 'ACTIVE',
        applications: { none: { worker_id: workerId } },
        ...(knownCategories.length > 0
          ? { category: { name: { notIn: knownCategories } } }
          : {}),
      },
      select: { id: true },
      take: limit * 5,
      orderBy: { created_at: 'desc' },
    });

    const shuffled = unexploredJobs
      .sort(() => Math.random() - 0.5)
      .slice(0, limit);

    return shuffled.map((j) => ({
      jobId: j.id,
      score: 0,
      source: 'explore' as const,
    }));
  }

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

    const filter = {
      must: [
        { key: 'status', match: { value: 'OPEN' } },
        { key: 'is_deleted', match: { value: false } },
      ],
      must_not: [{ key: 'applied_worker_ids', match: { any: [workerId] } }],
    };

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
}
