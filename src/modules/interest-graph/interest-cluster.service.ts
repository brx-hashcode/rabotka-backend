import { Injectable, Logger } from '@nestjs/common';
import { QdrantService } from '../qdrant/qdrant.service';
import { InterestSignalService } from './interest-signal.service';

// Recluster every N interactions to avoid thrashing
const RECLUSTER_THRESHOLD = 10;
const POSITIVE_THRESHOLD = 0.1;
const NEGATIVE_THRESHOLD = -0.1;
const USER_INTERESTS_COLLECTION: string = 'rabotka_user_interests';
const SIGNALS_COLLECTION: string = 'rabotka_signals';

export interface UserInterestProfile {
  positiveVectors: number[][];
  negativeVectors: number[][];
  categories: string[];
  totalSignals: number;
}

@Injectable()
export class InterestClusterService {
  private readonly logger = new Logger(InterestClusterService.name);
  private readonly interactionCounts = new Map<string, number>();

  constructor(
    private readonly qdrant: QdrantService,
    private readonly signals: InterestSignalService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.qdrant.ensureDenseCollection(USER_INTERESTS_COLLECTION);
    this.logger.log(
      `User interests collection ready: ${USER_INTERESTS_COLLECTION}`,
    );
  }

  async maybeRecluster(userId: string): Promise<void> {
    const count = (this.interactionCounts.get(userId) ?? 0) + 1;
    this.interactionCounts.set(userId, count);

    if (count % RECLUSTER_THRESHOLD !== 0) return;

    await this.recluster(userId);
  }

  async recluster(userId: string): Promise<void> {
    const recentSignals = await this.signals.getRecentSignals(userId);
    if (recentSignals.length === 0) return;

    const positiveByCategory = new Map<
      string,
      { vectors: number[][]; totalWeight: number }
    >();
    const negativeByCategory = new Map<
      string,
      { vectors: number[][]; totalWeight: number }
    >();

    // Fetch vectors for all signal job IDs in one scroll
    const jobIds = [...new Set(recentSignals.map((s) => s.jobId))];
    const signalPoints = await this.scrollSignalVectorsByJobIds(userId, jobIds);

    for (const signal of recentSignals) {
      const vector = signalPoints.get(signal.jobId);
      if (!vector) continue;

      const category = signal.category ?? '__uncategorized__';
      const weight = Math.abs(signal.effectiveWeight);
      const map =
        signal.effectiveWeight >= POSITIVE_THRESHOLD
          ? positiveByCategory
          : negativeByCategory;

      if (
        signal.effectiveWeight <= NEGATIVE_THRESHOLD ||
        signal.effectiveWeight >= POSITIVE_THRESHOLD
      ) {
        const entry = map.get(category) ?? { vectors: [], totalWeight: 0 };
        entry.vectors.push(this.scaleVector(vector, weight));
        entry.totalWeight += weight;
        map.set(category, entry);
      }
    }

    // Build weighted-average medoid per category
    const positiveVectors: number[][] = [];
    const negativeVectors: number[][] = [];
    const seenCategories = new Set<string>();

    for (const [cat, { vectors, totalWeight }] of positiveByCategory) {
      if (totalWeight === 0) continue;
      positiveVectors.push(this.averageVectors(vectors, totalWeight));
      seenCategories.add(cat);
    }

    for (const [, { vectors, totalWeight }] of negativeByCategory) {
      if (totalWeight === 0) continue;
      negativeVectors.push(this.averageVectors(vectors, totalWeight));
    }

    const profilePointId = `interest__${userId}`;
    await this.qdrant.upsertDense(
      USER_INTERESTS_COLLECTION,
      profilePointId,
      positiveVectors[0] ?? new Array(384).fill(0),
      {
        user_id: userId,
        positive_vectors: positiveVectors,
        negative_vectors: negativeVectors,
        categories: [...seenCategories],
        total_signals: recentSignals.length,
        updated_at: new Date().toISOString(),
      },
    );

    this.logger.debug(
      `Reclustered user=${userId}: ${positiveVectors.length} positive, ${negativeVectors.length} negative medoids`,
    );
  }

  async getProfile(userId: string): Promise<UserInterestProfile | null> {
    const pointId = `interest__${userId}`;
    const result = await this.qdrant
      .getClient()
      .retrieve(USER_INTERESTS_COLLECTION, {
        ids: [pointId],
        with_payload: true,
        with_vector: false,
      });

    if (!result.length) return null;

    const payload = result[0].payload as Record<string, unknown>;
    return {
      positiveVectors: (payload.positive_vectors as number[][]) ?? [],
      negativeVectors: (payload.negative_vectors as number[][]) ?? [],
      categories: (payload.categories as string[]) ?? [],
      totalSignals: (payload.total_signals as number) ?? 0,
    };
  }

  private scaleVector(vec: number[], scale: number): number[] {
    return vec.map((v) => v * scale);
  }

  private averageVectors(
    scaledVecs: number[][],
    totalWeight: number,
  ): number[] {
    const dim = scaledVecs[0]?.length ?? 384;
    const sum = new Array<number>(dim).fill(0);
    for (const v of scaledVecs) {
      for (let i = 0; i < dim; i++) {
        sum[i] += v[i];
      }
    }
    return sum.map((v) => v / totalWeight);
  }

  private async scrollSignalVectorsByJobIds(
    userId: string,
    jobIds: string[],
  ): Promise<Map<string, number[]>> {
    // Signals are keyed as `${userId}__${jobId}__${type}` — grab most positive per job
    // We'll fetch all user signals and pick the first per jobId for the vector
    const map = new Map<string, number[]>();
    if (!jobIds.length) return map;

    // Retrieve a sample point per job (use 'view' type as canonical vector source)
    const pointIds = jobIds.map((jid) => `${userId}__${jid}__view`);
    const altIds = jobIds.map((jid) => `${userId}__${jid}__apply`);
    const all = [...pointIds, ...altIds];

    const results = await this.qdrant.getClient().retrieve(SIGNALS_COLLECTION, {
      ids: all,
      with_payload: true,
      with_vector: true,
    });

    for (const point of results) {
      const payload = point.payload as Record<string, unknown>;
      const jobId = payload.job_id;
      if (typeof jobId !== 'string') continue;
      const dense = (point as unknown as { vector: { dense: number[] } }).vector
        ?.dense;
      if (!map.has(jobId) && Array.isArray(dense)) {
        map.set(jobId, dense);
      }
    }

    return map;
  }
}
