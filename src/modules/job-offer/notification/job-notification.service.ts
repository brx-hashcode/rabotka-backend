import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  JobOfferStatus,
} from '@prisma/client';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { MatchingService } from '../../matching/matching.service';
import { EngineRolloutService } from '../../recommendation-engine/engine-rollout.service';
import { InteractionEventService } from '../../recommendation-engine/interaction-event.service';
import { RecommendationEngineService } from '../../recommendation-engine/recommendation-engine.service';
import { SystemConfigService } from '../../system-config/system-config.service';

/** How many WhatsApp sends may be in flight at once for one offer. */
export const NOTIFY_CONCURRENCY = 5;

/**
 * How long the "already told this worker about this offer" marker survives.
 *
 * Only has to outlive the retry window, not the offer: once BullMQ has stopped
 * retrying, a second fan-out for the same offer cannot happen.
 */
export const SENT_MARKER_TTL_SECONDS = 86_400;

/** Offers that are still worth telling anyone about. */
const NOTIFIABLE_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

export type NotifyOutcome = {
  ranked: number;
  sent: number;
  skippedCooldown: number;
  skippedAlreadySent: number;
  failed: number;
};

type RankedWorkerRef = { id: string; score: number };

/**
 * Decides who hears about a new job offer, and tells them.
 *
 * Lives outside `JobOfferService` because it used to be a detached promise
 * chain inside `create()` — unreachable from a test, unretryable, and lost on
 * every deploy. Everything here is driven by one entry point so the fan-out can
 * be asserted on directly.
 */
@Injectable()
export class JobNotificationService {
  private readonly logger = new Logger(JobNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly matching: MatchingService,
    private readonly engine: RecommendationEngineService,
    private readonly rollout: EngineRolloutService,
    private readonly botNotification: BotNotificationService,
    private readonly interactions: InteractionEventService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  /**
   * Anti-fatigue gate. Global to the worker, not scoped to an offer: the point
   * is a ceiling on how often anyone is messaged at all.
   */
  private cooldownKey(workerId: string): string {
    return `job_notif_cooldown:${workerId}`;
  }

  /**
   * Idempotency marker, scoped to the pair. Distinct from the cooldown because
   * the two answer different questions — "may we message them at all right now"
   * versus "did this exact fan-out already reach them" — and a retried queue job
   * must be able to tell them apart.
   */
  private sentKey(jobOfferId: string, workerId: string): string {
    return `job_notif_sent:${jobOfferId}:${workerId}`;
  }

  async notifyForOffer(jobOfferId: string): Promise<NotifyOutcome> {
    const empty: NotifyOutcome = {
      ranked: 0,
      sent: 0,
      skippedCooldown: 0,
      skippedAlreadySent: 0,
      failed: 0,
    };

    const [enabled, minScore, maxWorkers, cooldownMinutes] = await Promise.all([
      this.systemConfig.isRecommendationEnabled(),
      this.systemConfig.getMinNotificationScore(),
      this.systemConfig.getMaxNotificationWorkers(),
      this.systemConfig.getNotificationCooldownMinutes(),
    ]);
    if (!enabled) return empty;

    const offer = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        employer_id: true,
        category_id: true,
        status: true,
        deleted_at: true,
      },
    });

    // A queued job runs after a delay, so by the time it fires the offer may
    // have been filled or deleted. The inline chain this replaced could not
    // even express that, because it ran while `create` was still on the stack.
    if (
      !offer ||
      offer.deleted_at ||
      !NOTIFIABLE_STATUSES.includes(offer.status)
    ) {
      return empty;
    }

    const ranked = await this.rank(offer, maxWorkers, minScore);
    if (ranked.length === 0) return empty;

    const outcome: NotifyOutcome = { ...empty, ranked: ranked.length };

    // A cursor pool, not a busy-wait. The previous limiter raced a promise array
    // that it also kept appending to, so once past the cap `Promise.race`
    // resolved instantly off an already-settled entry and the loop spun through
    // microtasks — an O(n) race per turn — until a send happened to finish.
    let cursor = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(NOTIFY_CONCURRENCY, ranked.length) },
        async () => {
          while (cursor < ranked.length) {
            await this.notifyOne(
              ranked[cursor++],
              offer,
              cooldownMinutes,
              outcome,
            );
          }
        },
      ),
    );

    this.logger.log(
      `offer ${offer.id}: ranked=${outcome.ranked} sent=${outcome.sent} ` +
        `cooldown=${outcome.skippedCooldown} duplicate=${outcome.skippedAlreadySent} ` +
        `failed=${outcome.failed}`,
    );

    return outcome;
  }

  /**
   * Ranks the workers worth telling, on whichever engine this employer is
   * bucketed onto.
   *
   * Bucketed by employer rather than by worker: bucketing per worker would split
   * a single offer's fan-out across both rankers, and any comparison of
   * notification-to-application conversion between the two would then be
   * measuring a mixture of itself.
   */
  private async rank(
    offer: { id: string; employer_id: string },
    limit: number,
    minScore: number,
  ): Promise<RankedWorkerRef[]> {
    if ((await this.rollout.versionFor(offer.employer_id)) === 'v2') {
      try {
        // No fallback on an empty result, unlike the feed controllers. There an
        // empty list is a bug; here it is the whole point of `keepAtLeast: 0`,
        // and falling through would restore the floored threshold this exists
        // to escape. Only a throw falls back.
        return await this.engine.recommendWorkersForJobOffer(offer.id, limit, {
          minScore,
          keepAtLeast: 0,
          explore: false,
          strictCategory: true,
          requireVerified: await this.systemConfig.notifyRequiresVerified(),
        });
      } catch (err) {
        this.logger.warn(
          `v2 ranking failed for offer ${offer.id}, falling back to legacy`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Legacy keeps its caller-side threshold: its own `applyThreshold` is
    // floored, so it returns its best few however bad they are.
    const ranked = await this.matching.findMatchingWorkersForJob(
      offer.id,
      limit,
    );
    return ranked.filter((w) => w.score >= minScore);
  }

  /**
   * One recipient: gate, claim, send, then settle the claim against the result.
   *
   * The claim is released when nothing was sent, which is the whole reason
   * `sendRecommendedJobNotification` reports a boolean. Holding it on failure
   * silenced a worker for an hour over a message they never received.
   */
  private async notifyOne(
    worker: RankedWorkerRef,
    offer: { id: string; employer_id: string; category_id: string | null },
    cooldownMinutes: number,
    outcome: NotifyOutcome,
  ): Promise<void> {
    const sentKey = this.sentKey(offer.id, worker.id);
    if (await this.redis.exists(sentKey)) {
      outcome.skippedAlreadySent++;
      return;
    }

    const cooldownKey = this.cooldownKey(worker.id);
    if (cooldownMinutes > 0) {
      const claimed = await this.redis.set(
        cooldownKey,
        '1',
        'EX',
        cooldownMinutes * 60,
        'NX',
      );
      if (claimed === null) {
        outcome.skippedCooldown++;
        return;
      }
    }

    let sent = false;
    try {
      sent = await this.botNotification.sendRecommendedJobNotification(
        worker.id,
        offer.id,
      );
    } catch (err) {
      this.logger.warn(
        `sendRecommendedJobNotification threw for worker ${worker.id}`,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!sent) {
      outcome.failed++;
      if (cooldownMinutes > 0) await this.redis.del(cooldownKey);
      return;
    }

    outcome.sent++;
    await this.redis.set(sentKey, '1', 'EX', SENT_MARKER_TTL_SECONDS);
    await this.recordServed(worker.id, offer);
  }

  /**
   * Books the recommendation as an interaction.
   *
   * Weight is zero, so this moves no affinity — it exists so notification
   * fatigue is measurable and so notification-to-application conversion can be
   * computed against the `APPLY` events that already land in the same table.
   */
  private async recordServed(
    workerId: string,
    offer: { id: string; employer_id: string; category_id: string | null },
  ): Promise<void> {
    try {
      await this.interactions.record({
        actorId: workerId,
        actorType: InteractionActor.WORKER,
        kind: InteractionKind.RECOMMENDATION_SERVED,
        objectType: InteractionObject.JOB_OFFER,
        objectId: offer.id,
        categoryId: offer.category_id,
        counterpartyId: offer.employer_id,
        source: InteractionSource.SERVER,
        surface: 'whatsapp_job_notification',
      });
    } catch (err) {
      // Bookkeeping must never turn a delivered message into a failed job.
      this.logger.warn(
        `Failed to record RECOMMENDATION_SERVED for worker ${workerId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
