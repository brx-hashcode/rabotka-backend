import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  InterestSignalService,
  INTEREST_RECLUSTER_QUEUE,
  type SignalType,
} from './interest-signal.service';

const VECTOR_DIM = 384;

function toPointId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const INTEREST_RECLUSTER_QUEUE_NAME: string = INTEREST_RECLUSTER_QUEUE;
const USER_INTERESTS_COLLECTION: string = COLLECTIONS.USER_INTERESTS;

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
    const collection: string = COLLECTIONS.USER_INTERESTS;
    await this.qdrant.ensureDenseCollection(collection);
    this.logger.log(`User interests collection ready: ${collection}`);
    this.registerReclusterWorker();
  }

  // ── BullMQ worker ─────────────────────────────────────────────────────────

  private registerReclusterWorker(): void {
    this.queue.createWorker<{ userId: string }>(
      INTEREST_RECLUSTER_QUEUE_NAME,
      async (job) => {
        await this.recluster(job.data.userId);
      },
      { concurrency: 3 },
    );
    this.logger.log(
      `Recluster worker registered on ${INTEREST_RECLUSTER_QUEUE_NAME}`,
    );
  }

  // ── Core recluster logic ──────────────────────────────────────────────────

  async recluster(userId: string): Promise<void> {
    const recentSignals = await this.signals.getRecentSignals(userId);
    if (recentSignals.length === 0) return;

    const deduplicated = deduplicateByJob(recentSignals);
    const vectorMap = await this.fetchSignalVectors(
      userId,
      deduplicated.map((s) => s.jobId),
    );

    const { positiveByCategory, negativeByCategory } = bucketByCategory(
      deduplicated,
      vectorMap,
    );

    const { positiveVectors, negativeVectors, seenCategories } = buildMedoids(
      positiveByCategory,
      negativeByCategory,
    );

    const anchor: number[] =
      positiveVectors[0] ?? Array.from<number>({ length: VECTOR_DIM }).fill(0);

    await this.qdrant.upsertDense(
      USER_INTERESTS_COLLECTION,
      toPointId(`interest__${userId}`),
      anchor,
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
      `Reclustered user=${userId}: ${positiveVectors.length} positive, ` +
        `${negativeVectors.length} negative medoids from ${deduplicated.length} unique jobs`,
    );
  }

  async getProfile(userId: string): Promise<UserInterestProfile | null> {
    const pointId = toPointId(`interest__${userId}`);
    let result: { id: string | number; payload?: Record<string, unknown> | null }[];
    try {
      result = await this.qdrant
        .getClient()
        .retrieve(USER_INTERESTS_COLLECTION, {
          ids: [pointId],
          with_payload: true,
          with_vector: false,
        });
    } catch {
      return null;
    }

    if (!result.length) return null;

    const raw = result[0].payload;
    if (!raw || typeof raw !== 'object') return null;
    const payload = raw as Record<string, unknown>;

    return {
      positiveVectors: isMatrix(payload.positive_vectors)
        ? payload.positive_vectors
        : [],
      negativeVectors: isMatrix(payload.negative_vectors)
        ? payload.negative_vectors
        : [],
      categories: isStringArray(payload.categories) ? payload.categories : [],
      totalSignals:
        typeof payload.total_signals === 'number' ? payload.total_signals : 0,
    };
  }

  // ── Vector retrieval ──────────────────────────────────────────────────────

  private async fetchSignalVectors(
    userId: string,
    jobIds: string[],
  ): Promise<Map<string, number[]>> {
    const map = new Map<string, number[]>();
    if (!jobIds.length) return map;

    const signalsCollection: string = COLLECTIONS.SIGNALS;
    const signalTypes: SignalType[] = [
      'apply',
      'share',
      'save',
      'question',
      'profile_view',
      'view',
      'skip',
      'cancel',
      'dislike',
    ];

    const candidateIds = jobIds.flatMap((jid) =>
      signalTypes.map((t) => toPointId(`${userId}__${jid}__${t}`)),
    );

    const results = await this.qdrant.getClient().retrieve(signalsCollection, {
      ids: candidateIds,
      with_payload: true,
      with_vector: true,
    });

    for (const point of results) {
      const raw = point.payload;
      if (!raw || typeof raw !== 'object') continue;
      const payload = raw as Record<string, unknown>;
      const jobId = payload.job_id;
      if (typeof jobId !== 'string') continue;
      if (map.has(jobId)) continue;

      const v = point as unknown as { vector?: { dense?: unknown } };
      const dense = v.vector?.dense;
      if (isNumberArray(dense)) {
        map.set(jobId, dense);
      }
    }

    return map;
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}

function isMatrix(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(isNumberArray);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// ── Recluster helpers ─────────────────────────────────────────────────────────

type DeduplicatedSignal = {
  jobId: string;
  effectiveWeight: number;
  category: string | null;
  type: SignalType;
};

type CategoryBucket = { vectors: number[][]; totalWeight: number };

function deduplicateByJob(
  signals: Array<{
    jobId: string;
    effectiveWeight: number;
    category: string | null;
    type: SignalType;
  }>,
): DeduplicatedSignal[] {
  const byJob = new Map<string, DeduplicatedSignal>();
  for (const s of signals) {
    const existing = byJob.get(s.jobId);
    if (
      !existing ||
      Math.abs(s.effectiveWeight) > Math.abs(existing.effectiveWeight)
    ) {
      byJob.set(s.jobId, s);
    }
  }
  return [...byJob.values()];
}

function bucketByCategory(
  deduplicated: DeduplicatedSignal[],
  vectorMap: Map<string, number[]>,
): {
  positiveByCategory: Map<string, CategoryBucket>;
  negativeByCategory: Map<string, CategoryBucket>;
} {
  const positiveByCategory = new Map<string, CategoryBucket>();
  const negativeByCategory = new Map<string, CategoryBucket>();

  for (const signal of deduplicated) {
    const vector = vectorMap.get(signal.jobId);
    if (!vector) continue;

    const category = signal.category ?? '__uncategorized__';
    const absWeight = Math.abs(signal.effectiveWeight);

    if (signal.effectiveWeight >= 0.1) {
      const entry = positiveByCategory.get(category) ?? {
        vectors: [],
        totalWeight: 0,
      };
      entry.vectors.push(scaleVector(vector, absWeight));
      entry.totalWeight += absWeight;
      positiveByCategory.set(category, entry);
    } else if (signal.effectiveWeight <= -0.1) {
      const entry = negativeByCategory.get(category) ?? {
        vectors: [],
        totalWeight: 0,
      };
      entry.vectors.push(scaleVector(vector, absWeight));
      entry.totalWeight += absWeight;
      negativeByCategory.set(category, entry);
    }
  }

  return { positiveByCategory, negativeByCategory };
}

function buildMedoids(
  positiveByCategory: Map<string, CategoryBucket>,
  negativeByCategory: Map<string, CategoryBucket>,
): {
  positiveVectors: number[][];
  negativeVectors: number[][];
  seenCategories: Set<string>;
} {
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

  return { positiveVectors, negativeVectors, seenCategories };
}

// ── Pure math helpers ─────────────────────────────────────────────────────────

function scaleVector(vec: number[], scale: number): number[] {
  return vec.map((v) => v * scale);
}

function averageVectors(scaledVecs: number[][], totalWeight: number): number[] {
  const dim = scaledVecs[0]?.length ?? VECTOR_DIM;
  const sum = Array.from<number>({ length: dim }).fill(0);
  for (const v of scaledVecs) {
    for (let i = 0; i < dim; i++) {
      sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  return sum.map((v) => v / totalWeight);
}
