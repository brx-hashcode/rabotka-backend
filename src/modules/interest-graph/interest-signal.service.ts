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

export const SIGNAL_HALF_LIFE_DAYS = 21;
export const SIGNAL_MAX_AGE_DAYS = 180;

/**
 * Exponential recency decay.
 *
 * Replaces a step function (1.0 / 0.7 / 0.4 / 0 at 30 / 60 / 90 days) that cut a
 * signal's influence by 30% overnight on day 31 — so a user's feed could visibly
 * shift without them doing anything. Smooth decay also means "how recent" is
 * expressed once, as a half-life, instead of three arbitrary cliffs.
 */
/**
 * @param now  Evaluation instant. Defaults to wall-clock, but offline replay
 *             MUST pass its `asOf` cutoff: otherwise age — and therefore the
 *             SIGNAL_MAX_AGE_DAYS cliff — is measured from today rather than
 *             from the moment being replayed, silently discarding history that
 *             was still live at that point.
 */
export function temporalWeight(
  recordedAt: Date,
  halfLifeDays = SIGNAL_HALF_LIFE_DAYS,
  now: Date = new Date(),
): number {
  const ageDays =
    (now.getTime() - recordedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays >= SIGNAL_MAX_AGE_DAYS) return 0;
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
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
    let vector = await this.tryGetIndexedVector(COLLECTIONS.JOBS, jobId);
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

    // Fire-and-forget — EMA update must not block the signal recording response
    void this.clusters
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

  /**
   * Records that an employer looked at a WORKER's profile.
   *
   * `record()` cannot express this: it is keyed on a job offer and returns early
   * when the id doesn't resolve to one. The bot previously worked around that by
   * passing the employer's *own* job offer id, which taught the employer's vector
   * about their own postings and discarded which worker was actually viewed — so
   * employer→worker view history existed nowhere.
   */
  async recordWorkerProfileView(
    employerId: string,
    workerId: string,
    context?: { sessionId?: string },
  ): Promise<void> {
    const weight = SIGNAL_WEIGHTS.profile_view;
    const worker = await this.prisma.profile.findUnique({
      where: { id: workerId },
      select: {
        first_name: true,
        last_name: true,
        categories: { select: { category: { select: { name: true } } } },
      },
    });
    if (!worker) return;

    const categoryName = worker.categories[0]?.category?.name ?? null;
    let vector = await this.tryGetIndexedVector(COLLECTIONS.WORKERS, workerId);
    if (!vector) {
      const text = [
        `${worker.first_name} ${worker.last_name}`.trim(),
        categoryName,
      ]
        .filter(Boolean)
        .join('. ');
      if (!text) return;
      vector = await this.qdrant.embed(text);
    }

    const pointId = toPointId(`${employerId}__worker__${workerId}__profile_view`);
    await this.qdrant.upsertDense(COLLECTIONS.SIGNALS, pointId, vector, {
      user_id: employerId,
      worker_id: workerId,
      type: 'profile_view',
      weight,
      category: categoryName,
      recorded_at: new Date().toISOString(),
      session_id: context?.sessionId ?? null,
    });

    void this.clusters
      .applySignal(employerId, workerId, vector, weight, categoryName)
      .catch((err) => {
        this.logger.warn(`EMA update failed for employer=${employerId}`, err);
      });
  }

  /**
   * Reads an entity's already-indexed dense vector so we don't re-embed on the
   * hot path. Returns null when the entity isn't indexed yet or Qdrant errors.
   */
  private async tryGetIndexedVector(
    collection: string,
    id: string,
  ): Promise<number[] | null> {
    try {
      const points = await this.qdrant.getClient().retrieve(collection, {
        ids: [id],
        with_vector: ['dense'],
        with_payload: false,
      });
      const raw = points[0] as unknown as
        | { vector?: { dense?: unknown } }
        | undefined;
      const dense = raw?.vector?.dense;
      return Array.isArray(dense) && dense.length > 0
        ? (dense as number[])
        : null;
    } catch {
      return null;
    }
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
