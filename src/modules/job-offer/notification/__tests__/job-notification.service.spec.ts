import { Test, TestingModule } from '@nestjs/testing';
import { InteractionKind, JobOfferStatus } from '@prisma/client';
import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../../../bot/services/bot-notification.service';
import { MatchingService } from '../../../matching/matching.service';
import { EngineRolloutService } from '../../../recommendation-engine/engine-rollout.service';
import { InteractionEventService } from '../../../recommendation-engine/interaction-event.service';
import { RecommendationEngineService } from '../../../recommendation-engine/recommendation-engine.service';
import { SystemConfigService } from '../../../system-config/system-config.service';
import {
  JobNotificationService,
  NOTIFY_CONCURRENCY,
} from '../job-notification.service';

const OFFER_ID = 'offer-1';
const EMPLOYER_ID = 'employer-1';

const workers = (n: number, score = 0.9) =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, score }));

describe('JobNotificationService', () => {
  let service: JobNotificationService;
  let prisma: { jobOffer: { findUnique: jest.Mock } };
  let systemConfig: {
    isRecommendationEnabled: jest.Mock;
    getMinNotificationScore: jest.Mock;
    getMaxNotificationWorkers: jest.Mock;
    getNotificationCooldownMinutes: jest.Mock;
    notifyRequiresVerified: jest.Mock;
  };
  let matching: { findMatchingWorkersForJob: jest.Mock };
  let engine: { recommendWorkersForJobOffer: jest.Mock };
  let rollout: { versionFor: jest.Mock };
  let bot: { sendRecommendedJobNotification: jest.Mock };
  let interactions: { record: jest.Mock };
  let redis: { set: jest.Mock; del: jest.Mock; exists: jest.Mock };

  beforeEach(async () => {
    prisma = {
      jobOffer: {
        findUnique: jest.fn().mockResolvedValue({
          id: OFFER_ID,
          employer_id: EMPLOYER_ID,
          category_id: 'cat-1',
          status: JobOfferStatus.ACTIVE,
          deleted_at: null,
        }),
      },
    };
    systemConfig = {
      isRecommendationEnabled: jest.fn().mockResolvedValue(true),
      getMinNotificationScore: jest.fn().mockResolvedValue(0.55),
      getMaxNotificationWorkers: jest.fn().mockResolvedValue(20),
      getNotificationCooldownMinutes: jest.fn().mockResolvedValue(60),
      notifyRequiresVerified: jest.fn().mockResolvedValue(false),
    };
    matching = {
      findMatchingWorkersForJob: jest.fn().mockResolvedValue(workers(3)),
    };
    engine = {
      recommendWorkersForJobOffer: jest.fn().mockResolvedValue(workers(3)),
    };
    // Legacy by default, matching the shipped config.
    rollout = { versionFor: jest.fn().mockResolvedValue('legacy') };
    bot = { sendRecommendedJobNotification: jest.fn().mockResolvedValue(true) };
    interactions = { record: jest.fn().mockResolvedValue(undefined) };
    redis = {
      // `set … NX` returns 'OK' when the claim is won, null when it is not.
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobNotificationService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: systemConfig },
        { provide: MatchingService, useValue: matching },
        { provide: RecommendationEngineService, useValue: engine },
        { provide: EngineRolloutService, useValue: rollout },
        { provide: BotNotificationService, useValue: bot },
        { provide: InteractionEventService, useValue: interactions },
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get(JobNotificationService);
  });

  describe('gates before any send', () => {
    it('does nothing when recommendations are disabled', async () => {
      systemConfig.isRecommendationEnabled.mockResolvedValue(false);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.sent).toBe(0);
      expect(matching.findMatchingWorkersForJob).not.toHaveBeenCalled();
      expect(bot.sendRecommendedJobNotification).not.toHaveBeenCalled();
    });

    it('does nothing when the offer is gone by the time the job runs', async () => {
      // The whole reason this moved onto a queue: it now runs after a delay, so
      // the offer can have been deleted in between.
      prisma.jobOffer.findUnique.mockResolvedValue(null);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.sent).toBe(0);
      expect(matching.findMatchingWorkersForJob).not.toHaveBeenCalled();
    });

    it('does nothing when the offer is soft-deleted', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: OFFER_ID,
        employer_id: EMPLOYER_ID,
        category_id: null,
        status: JobOfferStatus.ACTIVE,
        deleted_at: new Date(),
      });

      expect((await service.notifyForOffer(OFFER_ID)).sent).toBe(0);
      expect(bot.sendRecommendedJobNotification).not.toHaveBeenCalled();
    });

    it('does nothing once the offer has left the notifiable statuses', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: OFFER_ID,
        employer_id: EMPLOYER_ID,
        category_id: null,
        status: JobOfferStatus.EXPIRED,
        deleted_at: null,
      });

      expect((await service.notifyForOffer(OFFER_ID)).sent).toBe(0);
      expect(bot.sendRecommendedJobNotification).not.toHaveBeenCalled();
    });

    it('drops workers scoring under the notification threshold', async () => {
      matching.findMatchingWorkersForJob.mockResolvedValue([
        { id: 'good', score: 0.9 },
        { id: 'marginal', score: 0.4 },
      ]);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.ranked).toBe(1);
      expect(bot.sendRecommendedJobNotification).toHaveBeenCalledTimes(1);
      expect(bot.sendRecommendedJobNotification).toHaveBeenCalledWith(
        'good',
        OFFER_ID,
      );
    });
  });

  describe('engine rollout', () => {
    it('buckets on the employer, so one offer uses one ranker throughout', async () => {
      // Bucketing per worker would split a single fan-out across both engines
      // and make notification-to-application conversion uninterpretable.
      await service.notifyForOffer(OFFER_ID);

      expect(rollout.versionFor).toHaveBeenCalledTimes(1);
      expect(rollout.versionFor).toHaveBeenCalledWith(EMPLOYER_ID);
    });

    it('uses the v2 ranker when bucketed onto it', async () => {
      rollout.versionFor.mockResolvedValue('v2');

      await service.notifyForOffer(OFFER_ID);

      expect(engine.recommendWorkersForJobOffer).toHaveBeenCalledWith(
        OFFER_ID,
        20,
        expect.objectContaining({
          minScore: 0.55,
          // The threshold must be allowed to return nothing here.
          keepAtLeast: 0,
          explore: false,
          strictCategory: true,
        }),
      );
      expect(matching.findMatchingWorkersForJob).not.toHaveBeenCalled();
    });

    it('uses the legacy ranker otherwise', async () => {
      await service.notifyForOffer(OFFER_ID);

      expect(matching.findMatchingWorkersForJob).toHaveBeenCalledWith(
        OFFER_ID,
        20,
      );
      expect(engine.recommendWorkersForJobOffer).not.toHaveBeenCalled();
    });

    it('falls back to legacy when the v2 ranker throws', async () => {
      rollout.versionFor.mockResolvedValue('v2');
      engine.recommendWorkersForJobOffer.mockRejectedValue(
        new Error('qdrant down'),
      );

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(matching.findMatchingWorkersForJob).toHaveBeenCalled();
      expect(outcome.sent).toBe(3);
    });

    it('treats an empty v2 result as the answer, not as a failure', async () => {
      // The feed controllers fall back on an empty list because an empty feed is
      // a bug. Here it is the correct outcome — falling through would restore
      // the floored threshold and message the least-bad of a bad set.
      rollout.versionFor.mockResolvedValue('v2');
      engine.recommendWorkersForJobOffer.mockResolvedValue([]);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(matching.findMatchingWorkersForJob).not.toHaveBeenCalled();
      expect(outcome.sent).toBe(0);
      expect(bot.sendRecommendedJobNotification).not.toHaveBeenCalled();
    });

    it('passes the KYC requirement through from config', async () => {
      rollout.versionFor.mockResolvedValue('v2');
      systemConfig.notifyRequiresVerified.mockResolvedValue(true);

      await service.notifyForOffer(OFFER_ID);

      expect(engine.recommendWorkersForJobOffer).toHaveBeenCalledWith(
        OFFER_ID,
        20,
        expect.objectContaining({ requireVerified: true }),
      );
    });

    it('does not re-filter the v2 result, which already applied the threshold', async () => {
      rollout.versionFor.mockResolvedValue('v2');
      engine.recommendWorkersForJobOffer.mockResolvedValue([
        { id: 'w0', score: 0.6 },
        { id: 'w1', score: 0.56 },
      ]);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.ranked).toBe(2);
    });
  });

  describe('cooldown', () => {
    it('skips a worker whose cooldown is already held, and keeps going', async () => {
      redis.set.mockImplementation((key: string) =>
        Promise.resolve(key.includes('w1') ? null : 'OK'),
      );

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.skippedCooldown).toBe(1);
      expect(outcome.sent).toBe(2);
      const notified = bot.sendRecommendedJobNotification.mock.calls.map(
        (c) => c[0],
      );
      expect(notified).toEqual(['w0', 'w2']);
    });

    it('releases the cooldown when nothing was sent', async () => {
      // Otherwise a provider failure mutes that worker for a full hour over a
      // message they never received.
      bot.sendRecommendedJobNotification.mockResolvedValue(false);

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.sent).toBe(0);
      expect(outcome.failed).toBe(3);
      expect(redis.del).toHaveBeenCalledTimes(3);
      expect(redis.del).toHaveBeenCalledWith('job_notif_cooldown:w0');
    });

    it('releases the cooldown when the send throws', async () => {
      bot.sendRecommendedJobNotification.mockRejectedValue(
        new Error('twilio down'),
      );

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.failed).toBe(3);
      expect(redis.del).toHaveBeenCalledWith('job_notif_cooldown:w0');
    });

    it('keeps the cooldown when the message went out', async () => {
      await service.notifyForOffer(OFFER_ID);

      expect(redis.del).not.toHaveBeenCalled();
    });

    it('claims no cooldown at all when it is configured off', async () => {
      systemConfig.getNotificationCooldownMinutes.mockResolvedValue(0);

      await service.notifyForOffer(OFFER_ID);

      const cooldownWrites = redis.set.mock.calls.filter(([key]: [string]) =>
        key.startsWith('job_notif_cooldown:'),
      );
      expect(cooldownWrites).toHaveLength(0);
      expect(bot.sendRecommendedJobNotification).toHaveBeenCalledTimes(3);
    });
  });

  describe('idempotency across a retry', () => {
    it('does not re-send to a worker already marked for this offer', async () => {
      redis.exists.mockImplementation((key: string) =>
        Promise.resolve(key === `job_notif_sent:${OFFER_ID}:w1` ? 1 : 0),
      );

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.skippedAlreadySent).toBe(1);
      expect(outcome.sent).toBe(2);
      // The marker short-circuits before the cooldown, so a retry cannot burn
      // an hour of someone's quota re-deciding not to message them.
      expect(redis.set).not.toHaveBeenCalledWith(
        'job_notif_cooldown:w1',
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it('writes the sent marker only after a confirmed send', async () => {
      bot.sendRecommendedJobNotification.mockImplementation(
        (workerId: string) => Promise.resolve(workerId !== 'w1'),
      );

      await service.notifyForOffer(OFFER_ID);

      const markers = redis.set.mock.calls
        .map(([key]: [string]) => key)
        .filter((key: string) => key.startsWith('job_notif_sent:'));
      expect(markers).toEqual([
        `job_notif_sent:${OFFER_ID}:w0`,
        `job_notif_sent:${OFFER_ID}:w2`,
      ]);
    });
  });

  describe('fan-out concurrency', () => {
    it('never exceeds the cap, and still reaches everyone', async () => {
      // Regression lock on the limiter this replaced: it raced a promise array
      // it also kept appending to, so past the cap it spun through microtasks
      // off already-settled entries instead of waiting.
      matching.findMatchingWorkersForJob.mockResolvedValue(workers(20));

      let inFlight = 0;
      let peak = 0;
      bot.sendRecommendedJobNotification.mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return true;
      });

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(peak).toBeLessThanOrEqual(NOTIFY_CONCURRENCY);
      expect(peak).toBeGreaterThan(1);
      expect(outcome.sent).toBe(20);
      expect(bot.sendRecommendedJobNotification).toHaveBeenCalledTimes(20);
    });

    it('does not spawn more runners than there are workers', async () => {
      matching.findMatchingWorkersForJob.mockResolvedValue(workers(2));

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.sent).toBe(2);
    });
  });

  describe('bookkeeping', () => {
    it('records one RECOMMENDATION_SERVED per delivered message', async () => {
      await service.notifyForOffer(OFFER_ID);

      expect(interactions.record).toHaveBeenCalledTimes(3);
      expect(interactions.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'w0',
          kind: InteractionKind.RECOMMENDATION_SERVED,
          objectId: OFFER_ID,
          counterpartyId: EMPLOYER_ID,
          categoryId: 'cat-1',
          surface: 'whatsapp_job_notification',
        }),
      );
    });

    it('records nothing for a worker who was never messaged', async () => {
      bot.sendRecommendedJobNotification.mockResolvedValue(false);

      await service.notifyForOffer(OFFER_ID);

      expect(interactions.record).not.toHaveBeenCalled();
    });

    it('still counts the send when the bookkeeping write fails', async () => {
      // A delivered message must not be undone by a failed analytics insert.
      interactions.record.mockRejectedValue(new Error('db down'));

      const outcome = await service.notifyForOffer(OFFER_ID);

      expect(outcome.sent).toBe(3);
    });
  });
});
