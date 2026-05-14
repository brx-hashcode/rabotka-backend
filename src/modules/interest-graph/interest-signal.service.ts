import { createHash } from 'node:crypto';
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { InterestClusterService } from './interest-cluster.service';

// Qdrant requires point IDs to be UUIDs or unsigned integers.
// We derive a deterministic UUID from a composite key using SHA-256.
function toPointId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type SignalType =
  | 'apply'
  | 'share'
  | 'save'
  | 'question'
  | 'view'
  | 'profile_view'
  | 'skip'
  | 'dislike'
  | 'cancel';

export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  apply: 1.0,
  share: 0.9,
  save: 0.8,
  question: 0.6,
  profile_view: 0.5,
  view: 0.3,
  skip: -0.3,
  dislike: -0.8,
  cancel: -0.5,
};

// Kept for backward compat — queue name referenced by admin controller
export const INTEREST_RECLUSTER_QUEUE = 'interest-recluster-queue';

// Temporal decay: signals older than 90 days excluded
export function temporalWeight(recordedAt: Date): number {
  const ageDays = (Date.now() - recordedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > 90) return 0;
  if (ageDays > 60) return 0.4;
  if (ageDays > 30) return 0.7;
  return 1.0;
}

@Injectable()
export class InterestSignalService {
  private readonly logger = new Logger(InterestSignalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    @Inject(forwardRef(() => InterestClusterService))
    private readonly clusters: InterestClusterService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.qdrant.ensureDenseCollection(COLLECTIONS.SIGNALS);
    this.logger.log(`Signals collection ready: ${COLLECTIONS.SIGNALS}`);
  }

  async record(
    userId: string,
    jobId: string,
    type: SignalType,
    context?: { sessionId?: string },
  ): Promise<void> {
    const baseWeight = SIGNAL_WEIGHTS[type];
    if (baseWeight === undefined) return;

    const job = await this.prisma.jobOffer.findUnique({
      where: { id: jobId },
      select: { category: { select: { name: true } }, title: true },
    });
    if (!job) return;

    // Reuse the pre-computed dense vector from the jobs collection — no re-embedding
    let vector: number[] | null = null;
    try {
      const points = await this.qdrant.getClient().retrieve(COLLECTIONS.JOBS, {
        ids: [jobId],
        with_vector: ['dense'],
        with_payload: false,
      });
      const raw = points[0] as unknown as
        | { vector?: { dense?: unknown } }
        | undefined;
      const dense = raw?.vector?.dense;
      if (Array.isArray(dense) && dense.length > 0) {
        vector = dense as number[];
      }
    } catch {
      // fall through to on-demand embedding
    }

    if (!vector) {
      const jobText = `${job.title}`.trim();
      vector = await this.qdrant.embed(jobText);
    }

    // One point per (user, job, type) — deterministic UUID from composite key
    const pointId = toPointId(`${userId}__${jobId}__${type}`);

    await this.qdrant.upsertDense(COLLECTIONS.SIGNALS, pointId, vector, {
      user_id: userId,
      job_id: jobId,
      type,
      weight: baseWeight,
      category: job.category?.name ?? null,
      recorded_at: new Date().toISOString(),
      session_id: context?.sessionId ?? null,
    });

    this.logger.debug(
      `Signal recorded: user=${userId} job=${jobId} type=${type} w=${baseWeight}`,
    );

    // EMA update — fires on every signal, no batching
    await this.clusters
      .applySignal(
        userId,
        jobId,
        vector,
        baseWeight,
        job.category?.name ?? null,
      )
      .catch((err) => {
        this.logger.warn(`EMA update failed for user=${userId}`, err);
      });
  }

  async getRecentSignals(userId: string): Promise<
    Array<{
      jobId: string;
      type: SignalType;
      weight: number;
      category: string | null;
      recordedAt: Date;
      effectiveWeight: number;
    }>
  > {
    const cutoff = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const result = await this.qdrant.getClient().scroll(COLLECTIONS.SIGNALS, {
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          { key: 'recorded_at', range: { gte: cutoff } },
        ],
      },
      limit: 500,
      with_payload: true,
      with_vector: false,
    });

    return result.points
      .map((p) => {
        const payload = p.payload as Record<string, unknown>;
        const recordedAt = new Date(payload.recorded_at as string);
        const tw = temporalWeight(recordedAt);
        const effectiveWeight = (payload.weight as number) * tw;
        return {
          jobId: payload.job_id as string,
          type: payload.type as SignalType,
          weight: payload.weight as number,
          category: payload.category as string | null,
          recordedAt,
          effectiveWeight,
        };
      })
      .filter((s) => s.effectiveWeight !== 0);
  }
}
