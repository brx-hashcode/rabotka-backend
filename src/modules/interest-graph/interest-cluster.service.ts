import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  InterestSignalService,
  INTEREST_RECLUSTER_QUEUE,
  type SignalType,
} from './interest-signal.service';

const POSITIVE_THRESHOLD = 0.1;
const NEGATIVE_THRESHOLD = -0.1;

export interface UserInterestProfile {
  positiveVectors: number[][];
  negativeVectors: number[][];
  categories: string[];
  totalSignals: number;
}

@Injectable()
export class InterestClusterService implements OnModuleInit {
  private readonly logger = new Logger(InterestClusterService.name);

  constructor(
    private readonly qdrant: QdrantService,
    private readonly signals: InterestSignalService,
    private readonly queue: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.qdrant.ensureDenseCollection(COLLECTIONS.USER_INTERESTS);
    this.logger.log(
      `User interests collection ready: ${COLLECTIONS.USER_INTERESTS}`,
    );
    this.registerReclusterWorker();
  }

  // ── BullMQ worker ─────────────────────────────────────────────────────────

  private registerReclusterWorker(): void {
    this.queue.createWorker<{ userId: string }>(
      INTEREST_RECLUSTER_QUEUE,
      async (job) => {
        await this.recluster(job.data.userId);
      },
      { concurrency: 3 },
    );
    this.logger.log(`Recluster worker registered on ${INTEREST_RECLUSTER_QUEUE}`);
  }

  // ── Core recluster logic ──────────────────────────────────────────────────

  async recluster(userId: string): Promise<void> {
    const recentSignals = await this.signals.getRecentSignals(userId);
    if (recentSignals.length === 0) return;

    // Deduplicate: keep strongest (highest |effectiveWeight|) signal per job
    const byJob = new Map<
      string,
      { effectiveWeight: number; category: string | null; type: SignalType }
    >();
    for (const s of recentSignals) {
      const existing = byJob.get(s.jobId);
      if (
        !existing ||
        Math.abs(s.effectiveWeight) > Math.abs(existing.effectiveWeight)
      ) {
        byJob.set(s.jobId, {
          effectiveWeight: s.effectiveWeight,
          category: s.category,
          type: s.type,
        });
      }
    }

    const deduplicated = [...byJob.entries()].map(
      ([jobId, { effectiveWeight, category, type }]) => ({
        jobId,
        effectiveWeight,
        category,
        type,
      }),
    );

    // Fetch vectors for deduplicated job IDs
    const vectorMap = await this.fetchSignalVectors(
      userId,
      deduplicated.map((s) => s.jobId),
    );

    const positiveByCategory = new Map<
      string,
      { vectors: number[][]; totalWeight: number }
    >();
    const negativeByCategory = new Map<
      string,
      { vectors: number[][]; totalWeight: number }
    >();

    for (const signal of deduplicated) {
      const vector = vectorMap.get(signal.jobId);
      if (!vector) continue;

      const category = signal.category ?? '__uncategorized__';
      const absWeight = Math.abs(signal.effectiveWeight);

      if (signal.effectiveWeight >= POSITIVE_THRESHOLD) {
        const entry = positiveByCategory.get(category) ?? {
          vectors: [],
          totalWeight: 0,
        };
        entry.vectors.push(scaleVector(vector, absWeight));
        entry.totalWeight += absWeight;
        positiveByCategory.set(category, entry);
      } else if (signal.effectiveWeight <= NEGATIVE_THRESHOLD) {
        const entry = negativeByCategory.get(category) ?? {
          vectors: [],
          totalWeight: 0,
        };
        entry.vectors.push(scaleVector(vector, absWeight));
        entry.totalWeight += absWeight;
        negativeByCategory.set(category, entry);
      }
    }

    const positiveVectors: number[][] = [];
    const negativeVectors: number[][] = [];
    const seenCategories = new Set<string>();

    for (const [cat, { vectors, totalWeight }] of positiveByCategory) {
      if (totalWeight === 0) continue;
      positiveVectors.push(averageVectors(vectors, totalWeight));
      seenCategories.add(cat);
    }
    for (const [, { vectors, totalWeight }] of negativeByCategory) {
      if (totalWeight === 0) continue;
      negativeVectors.push(averageVectors(vectors, totalWeight));
    }

    const profilePointId = `interest__${userId}`;
    await this.qdrant.upsertDense(
      COLLECTIONS.USER_INTERESTS,
      profilePointId,
      positiveVectors[0] ?? new Array(384).fill(0),
      {
        user_id: userId,
        positive_vectors: positiveVectors,
        negative_vectors: negativeVectors,
        categories: [...seenCategories],
        total_signals: deduplicated.length,
        updated_at: new Date().toISOString(),
      },
    );

    this.logger.debug(
      `Reclustered user=${userId}: ${positiveVectors.length} positive, ${negativeVectors.length} negative medoids from ${deduplicated.length} unique jobs`,
    );
  }

  async getProfile(userId: string): Promise<UserInterestProfile | null> {
    const pointId = `interest__${userId}`;
    const result = await this.qdrant
      .getClient()
      .retrieve(COLLECTIONS.USER_INTERESTS, {
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

  // ── Vector helpers ────────────────────────────────────────────────────────

  private async fetchSignalVectors(
    userId: string,
    jobIds: string[],
  ): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (!jobIds.length) return map;

    // Try signal types in priority order: apply > view > skip etc.
    // We stored one point per (user, job, type) — pick the highest-weight one
    const signalTypes: SignalType[] = [
      'apply', 'share', 'save', 'question', 'profile_view', 'view', 'skip', 'cancel', 'dislike',
    ];

    const candidateIds = jobIds.flatMap((jid) =>
      signalTypes.map((t) => `${userId}__${jid}__${t}`),
    );

    const results = await this.qdrant
      .getClient()
      .retrieve(COLLECTIONS.SIGNALS, {
        ids: candidateIds,
        with_payload: true,
        with_vector: true,
      });

    for (const point of results) {
      const payload = point.payload as Record<string, unknown>;
      const jobId = payload.job_id;
      if (typeof jobId !== 'string') continue;
      // First hit per jobId wins (apply comes before view in our order above)
      if (map.has(jobId)) continue;
      const dense = (
        point as unknown as { vector: { dense: number[] } }
      ).vector?.dense;
      if (Array.isArray(dense)) {
        map.set(jobId, dense);
      }
    }

    return map;
  }
}

// ── Pure math helpers ───────────────────────────────────────────────────────

function scaleVector(vec: number[], scale: number): number[] {
  return vec.map((v) => v * scale);
}

function averageVectors(scaledVecs: number[][], totalWeight: number): number[] {
  const dim = scaledVecs[0]?.length ?? 384;
  const sum = new Array<number>(dim).fill(0);
  for (const v of scaledVecs) {
    for (let i = 0; i < dim; i++) {
      sum[i] += v[i]!;
    }
  }
  return sum.map((v) => v / totalWeight);
}
