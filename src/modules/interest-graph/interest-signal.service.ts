import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';

export type SignalType =
  | 'apply'
  | 'share'
  | 'save'
  | 'question'
  | 'view'
  | 'skip'
  | 'dislike'
  | 'cancel';

const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  apply: 1.0,
  share: 0.9,
  save: 0.8,
  question: 0.6,
  view: 0.3,
  skip: -0.3,
  dislike: -0.8,
  cancel: -0.5,
};

// Signals older than 90 days are excluded; decay applied at 30/60 day thresholds
function temporalWeight(recordedAt: Date): number {
  const ageMs = Date.now() - recordedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > 90) return 0;
  if (ageDays > 60) return 0.4;
  if (ageDays > 30) return 0.7;
  return 1.0;
}

export interface RecordedSignal {
  userId: string;
  jobId: string;
  type: SignalType;
  weight: number;
  jobCategory: string | null;
}

@Injectable()
export class InterestSignalService {
  private readonly logger = new Logger(InterestSignalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
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
      select: { category: true, title: true, description: true },
    });
    if (!job) return;

    const jobText = `${job.title} ${job.description ?? ''}`.trim();
    const vector = await this.qdrant.embed(jobText);

    const pointId = `${userId}__${jobId}__${type}`;
    const now = new Date();

    await this.qdrant.upsertDense(COLLECTIONS.SIGNALS, pointId, vector, {
      user_id: userId,
      job_id: jobId,
      type,
      weight: baseWeight,
      category: job.category ?? null,
      recorded_at: now.toISOString(),
      session_id: context?.sessionId ?? null,
    });

    this.logger.debug(
      `Signal recorded: user=${userId} job=${jobId} type=${type} w=${baseWeight}`,
    );
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
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const result = await this.qdrant.getClient().scroll(COLLECTIONS.SIGNALS, {
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          {
            key: 'recorded_at',
            range: { gte: cutoff.toISOString() },
          },
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
        const weight = (payload.weight as number) * tw;
        return {
          jobId: payload.job_id as string,
          type: payload.type as SignalType,
          weight,
          category: payload.category as string | null,
          recordedAt,
          effectiveWeight: weight,
        };
      })
      .filter((s) => s.effectiveWeight !== 0);
  }

  getSignalWeight(type: SignalType): number {
    return SIGNAL_WEIGHTS[type] ?? 0;
  }
}
