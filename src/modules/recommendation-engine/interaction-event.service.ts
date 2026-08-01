import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const DEDUPE_PREFIX = `${REDIS_KEY_PREFIX}ievent:dedupe:`;

/**
 * Signed weight per interaction kind.
 *
 * Positives are scaled by how much commitment they represent: paying to unlock a
 * contact is worth far more than a glance. Negatives are deliberately smaller in
 * magnitude than the strongest positives — a rejection says something about one
 * pairing, not about a whole category.
 */
export const INTERACTION_WEIGHTS: Record<InteractionKind, number> = {
  // Passive
  IMPRESSION_BATCH: 0,
  VIEW: 0.3,
  PROFILE_VIEW: 0.5,
  PORTFOLIO_VIEW: 0.6,
  // Explicit intent
  SEARCH: 0,
  SEARCH_CLICK: 0.7,
  SAVE: 0.8,
  UNSAVE: -0.4,
  // Commitment
  APPLY: 1.0,
  APPLY_CANCEL: -0.6,
  ACCEPT: 1.0,
  REJECT: -0.5,
  COMPLETE: 1.2,
  NO_SHOW: -0.8,
  // Outcome
  RATE_POSITIVE: 1.0,
  RATE_NEGATIVE: -1.0,
  // Paid intent — strongest available signal
  CONTACT_UNLOCK: 1.0,
  CONTACT_PAID: 1.1,
  // Explicit negatives
  SKIP: -0.3,
  DISLIKE: -0.9,
  // Bookkeeping
  RECOMMENDATION_SERVED: 0,
};

/**
 * How long the same (actor, kind, object) triple is suppressed.
 *
 * This is NOT the old dedup: that one collapsed repeat interactions forever,
 * destroying frequency information. This only absorbs remount storms and rapid
 * back/forward within a short window, so genuine cross-session repeat views still
 * accumulate as separate rows. Commitment kinds are never suppressed.
 */
const DEDUPE_TTL_SECONDS: Partial<Record<InteractionKind, number>> = {
  VIEW: 300,
  PROFILE_VIEW: 300,
  PORTFOLIO_VIEW: 300,
  IMPRESSION_BATCH: 60,
  SEARCH: 30,
};

export type RecordEventInput = {
  actorId: string;
  actorType: InteractionActor;
  kind: InteractionKind;
  objectType: InteractionObject;
  objectId?: string | null;
  /** Denormalised so the aggregator never joins back. */
  categoryId?: string | null;
  counterpartyId?: string | null;
  source: InteractionSource;
  surface?: string;
  sessionId?: string;
  requestId?: string;
  position?: number;
  dwellMs?: number;
  metadata?: Prisma.InputJsonValue;
  /** Override the timestamp — used by the backfill so decay stays honest. */
  occurredAt?: Date;
  /** Override the resolved weight. Backfill only. */
  weight?: number;
};

/**
 * Write path for the behavioural log.
 *
 * Every call is safe to fire-and-forget: recording a signal must never fail a
 * user request, so all failures are swallowed with a warning.
 */
@Injectable()
export class InteractionEventService {
  private readonly logger = new Logger(InteractionEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async record(input: RecordEventInput): Promise<void> {
    try {
      if (await this.isDuplicate(input)) return;

      await this.prisma.interactionEvent.create({
        data: {
          actor_id: input.actorId,
          actor_type: input.actorType,
          kind: input.kind,
          object_type: input.objectType,
          object_id: input.objectId ?? null,
          category_id: input.categoryId ?? null,
          counterparty_id: input.counterpartyId ?? null,
          weight: input.weight ?? INTERACTION_WEIGHTS[input.kind] ?? 0,
          source: input.source,
          surface: input.surface ?? null,
          session_id: input.sessionId ?? null,
          request_id: input.requestId ?? null,
          position: input.position ?? null,
          dwell_ms: input.dwellMs ?? null,
          metadata: input.metadata ?? undefined,
          ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record ${input.kind} for actor=${input.actorId}`,
        err,
      );
    }
  }

  /**
   * Bulk insert, for the backfill and impression batches. Skips the dedupe
   * window — callers supply already-deduplicated rows.
   */
  async recordMany(inputs: RecordEventInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    try {
      const result = await this.prisma.interactionEvent.createMany({
        data: inputs.map((input) => ({
          actor_id: input.actorId,
          actor_type: input.actorType,
          kind: input.kind,
          object_type: input.objectType,
          object_id: input.objectId ?? null,
          category_id: input.categoryId ?? null,
          counterparty_id: input.counterpartyId ?? null,
          weight: input.weight ?? INTERACTION_WEIGHTS[input.kind] ?? 0,
          source: input.source,
          surface: input.surface ?? null,
          session_id: input.sessionId ?? null,
          request_id: input.requestId ?? null,
          position: input.position ?? null,
          dwell_ms: input.dwellMs ?? null,
          metadata: input.metadata ?? undefined,
          ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
        })),
      });
      return result.count;
    } catch (err) {
      this.logger.warn(`Failed to record ${inputs.length} events`, err);
      return 0;
    }
  }

  /**
   * True when this triple was recorded inside its suppression window. Redis
   * failures return false — losing dedup is much cheaper than losing the signal.
   */
  private async isDuplicate(input: RecordEventInput): Promise<boolean> {
    const ttl = DEDUPE_TTL_SECONDS[input.kind];
    if (!ttl || !input.objectId) return false;

    const key = `${DEDUPE_PREFIX}${input.actorId}:${input.kind}:${input.objectId}`;
    try {
      const set = await this.redis.set(key, '1', 'EX', ttl, 'NX');
      return set === null;
    } catch {
      return false;
    }
  }
}
