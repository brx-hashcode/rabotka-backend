import { inAppNotifications } from '../../../profile-notification/__tests__/in-app-notifications';
import { Logger } from '@nestjs/common';
import { ReminderProcessor } from '../reminder.processor';
import {
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
} from '@prisma/client';
import type { SystemConfigService } from '../../../system-config/system-config.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const buildApplication = (overrides: Record<string, unknown> = {}) => ({
  id: 'app-1',
  job_offer_id: 'offer-1',
  worker_id: 'worker-1',
  status: 'ACCEPTED',
  worker: { phone: '+1234567890' },
  job_offer: {
    id: 'offer-1',
    status: JobOfferStatus.FILLED,
    title: 'Maçon',
    scheduled_at: new Date('2026-03-13T10:00:00Z'),
    address: '123 rue principale',
    amount: 50,
    employer: {
      first_name: 'Jean',
      last_name: 'Dupont',
      phone: '+0987654321',
    },
  },
  ...overrides,
});

describe('ReminderProcessor', () => {
  let processor: ReminderProcessor;
  let prisma: jest.Mocked<any>;
  let whatsApp: jest.Mocked<any>;
  let queueService: jest.Mocked<any>;
  let redis: jest.Mocked<any>;
  let systemConfigService: jest.Mocked<SystemConfigService>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      application: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      jobOffer: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      profile: {
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((arg: unknown) => {
        if (typeof arg === 'function') {
          const tx = {
            application: {
              update: prisma.application.update,
            },
            jobOffer: {
              update: prisma.jobOffer.update,
            },
          };
          return (arg as (tx: unknown) => Promise<unknown>)(tx);
        }
        return Promise.all(arg as Promise<unknown>[]);
      }),
    };
    whatsApp = {
      sendTextMessage: jest.fn().mockResolvedValue(undefined),
      sendTemplateMessage: jest.fn().mockResolvedValue(true),
    };
    queueService = { addJob: jest.fn().mockResolvedValue('job-1') };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    systemConfigService = {
      getFees: jest.fn().mockResolvedValue({
        lateCancellationPenaltyFcfa: 5000,
        lateCancellationScoreDeduction: 5,
        cancellationThresholdHours: 4,
        reliabilityScoreMin: 50,
        employerLateCancelScoreDeduction: 5,
        billingBlockThreshold: 2,
      }),
    } as any;
    const contactUnlockService = {
      expirePendingAttemptsForJob: jest.fn().mockResolvedValue([]),
    } as any;
    const botNotification = {
      sendContactUnlockCreditConversionNotification: jest
        .fn()
        .mockResolvedValue(undefined),
    } as any;
    processor = new ReminderProcessor(
      prisma,
      whatsApp,
      queueService,
      redis,
      systemConfigService,
      contactUnlockService,
      botNotification,
    );
  });

  // ─── process() dispatch ───────────────────────────────────────────────────

  describe('process()', () => {
    it('calls runScan for type=scan', async () => {
      await processor.process({ data: { type: 'scan' } });
      expect(prisma.application.findMany).toHaveBeenCalled();
    });

    it('delegates to sendReminder24h for type=reminder_24h', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('delegates to sendReminderStart for type=reminder_start', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('logs a warning for unknown job type', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      await processor.process({ data: { type: 'unknown' } as never });
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // ─── runScan() ────────────────────────────────────────────────────────────

  describe('runScan()', () => {
    it('enqueues reminder_24h jobs for apps not yet notified', async () => {
      // Single query now: the 2h reminder was removed, leaving only the 24h window.
      prisma.application.findMany.mockResolvedValueOnce([{ id: 'app-24h' }]);
      // start window uses jobOffer.findMany (already mocked to return [])
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        { type: 'reminder_24h', applicationId: 'app-24h' },
        { jobId: '24h-app-24h' },
      );
    });

    it('skips reminder_24h if redis key already set', async () => {
      prisma.application.findMany
        .mockResolvedValueOnce([{ id: 'app-24h' }])
        .mockResolvedValueOnce([]);
      redis.get.mockResolvedValue('1');

      await processor.process({ data: { type: 'scan' } });
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it('enqueues reminder_start jobs for apps whose scheduled_at just passed', async () => {
      // expireOverdueOffers runs first (2 jobOffer.findMany calls), then start window
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart (FILLED/PARTIALLY_FILLED with workers)
        .mockResolvedValueOnce([]) // openOverdue (ACTIVE/PARTIALLY_FILLED empty)
        .mockResolvedValueOnce([
          { id: 'offer-1', applications: [{ id: 'app-start' }] },
        ]); // start window
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        { type: 'reminder_start', applicationId: 'app-start' },
        { jobId: 'start-app-start' },
      );
    });

    it('skips reminder_start if redis key already set', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([]) // openOverdue
        .mockResolvedValueOnce([
          { id: 'offer-1', applications: [{ id: 'app-start' }] },
        ]);
      redis.get.mockResolvedValue('1');

      await processor.process({ data: { type: 'scan' } });
      expect(queueService.addJob).not.toHaveBeenCalled();
    });
  });

  // ─── expireOverdueOffers() ────────────────────────────────────────────────

  describe('expireOverdueOffers() via scan', () => {
    it('marks overdue ACTIVE offers with no workers as EXPIRED', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart (FILLED/PARTIALLY_FILLED with workers)
        .mockResolvedValueOnce([
          {
            id: 'offer-1',
            title: 'Test',
            employer_id: 'emp-1',
            employer: { phone: '+1111', first_name: 'Bob' },
          },
        ]); // openOverdue (ACTIVE/PARTIALLY_FILLED empty)
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.EXPIRED },
        }),
      );
    });

    it('attributes the cancellation to SYSTEM, so it never bars a re-application', async () => {
      // An expired offer is the platform's own timeout. The worker did nothing,
      // so they must stay free to apply if the offer is republished.
      prisma.jobOffer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'offer-1',
          title: 'Test',
          employer_id: 'emp-1',
          employer: { phone: '+1111', first_name: 'Bob' },
        },
      ]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cancelled_by: 'SYSTEM' }),
        }),
      );
    });

    it('retires an undated offer on age, since it has no date to be past', async () => {
      // This scan is the ONLY thing that ever retires an offer, and it filtered
      // purely on scheduled_at — so a CDI/CDD/STAGE, which carries no closing
      // date, would sit ACTIVE in the feed forever.
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      const overdueQuery = prisma.jobOffer.findMany.mock.calls[1][0] as {
        where: { OR: unknown[] };
      };
      expect(overdueQuery.where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ scheduled_at: { lt: expect.any(Date) } }),
          expect.objectContaining({
            scheduled_at: null,
            created_at: { lt: expect.any(Date) },
          }),
        ]),
      );
    });

    it('never auto-starts an ongoing engagement', async () => {
      // Every type carries a date now. On a CDD/CDI/STAGE it is the day
      // applications close, not a start time — without this filter a staffed
      // CDI whose window shut would be flipped to IN_PROGRESS and its worker
      // asked whether a job with years left to run is finished.
      prisma.jobOffer.findMany.mockResolvedValue([] as never);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      const autoStartQuery = prisma.jobOffer.findMany.mock.calls[0][0] as {
        where: { employment_type: unknown };
      };
      expect(autoStartQuery.where.employment_type).toBe(EmploymentType.MISSION);
    });

    it('stops recruiting on a staffed engagement past its deadline', async () => {
      // The expiry scan will not touch these — it requires zero accepted
      // applications, since expiring an offer somebody was hired on would be
      // wrong. That left a quantity-3 offer with one hire stuck forever:
      // never full, so never closed; never empty, so never expired.
      prisma.jobOffer.findMany.mockResolvedValue([] as never);
      prisma.application.findMany.mockResolvedValue([] as never);
      prisma.jobOffer.findMany.mockResolvedValueOnce([] as never); // autoStart
      prisma.jobOffer.findMany.mockResolvedValueOnce([] as never); // expiry
      prisma.jobOffer.findMany.mockResolvedValueOnce([] as never); // start window
      prisma.jobOffer.findMany.mockResolvedValueOnce([
        { id: 'offer-cdd' },
      ] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.FILLED },
        }),
      );
    });

    it('cancels uncommitted applicants and notifies them when an offer expires', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([
          {
            id: 'offer-1',
            title: 'Ménage',
            employer_id: 'emp-1',
            employer: { phone: '+1111', first_name: 'Bob' },
            applications: [
              {
                id: 'app-a',
                worker: {
                  id: 'worker-a',
                  phone: '+2222',
                  first_name: 'Awa',
                },
              },
              {
                id: 'app-b',
                worker: {
                  id: 'worker-b',
                  phone: '+3333',
                  first_name: 'Beni',
                },
              },
            ],
          },
        ]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      // Offer → EXPIRED
      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: JobOfferStatus.EXPIRED } }),
      );
      // Uncommitted applications → CANCELLED with cancelled_at + reason
      expect(prisma.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ApplicationStatus.CANCELLED,
            cancelled_at: expect.any(Date),
            cancellation_reason: expect.any(String),
          }),
        }),
      );
      // Each worker notified (+ the employer)
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+2222',
        'offerExpiredApplicant',
        expect.any(Object),
        'worker-a',
      );
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+3333',
        'offerExpiredApplicant',
        expect.any(Object),
        'worker-b',
      );

      // ONCE each, and never the duplicate. `notifyExpiredOffer` used to send
      // every applicant `offerUnavailableWorker` from the same list the caller
      // was already sending `offerExpiredApplicant` to, so each of them got two
      // billed templates for one event.
      const perWorker = (phone: string) =>
        whatsApp.sendTemplateMessage.mock.calls.filter(
          (call: unknown[]) => call[0] === phone,
        );
      expect(perWorker('+2222')).toHaveLength(1);
      expect(perWorker('+3333')).toHaveLength(1);
      // On the template key alone, not via toHaveBeenCalledWith: the old call
      // passed three arguments where the surviving one passes four, so an
      // arity-bound matcher would pass without proving anything.
      const keysSent = whatsApp.sendTemplateMessage.mock.calls.map(
        (call: unknown[]) => call[1],
      );
      expect(keysSent).not.toContain('offerUnavailableWorker');
    });

    it('does not cancel applications when there are no overdue empty offers', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.application.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ApplicationStatus.CANCELLED,
          }),
        }),
      );
    });

    it('auto-starts FILLED offers that have accepted workers', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-filled',
            title: 'Filled',
            employer_id: 'emp-filled',
            employer: { phone: '+5555', first_name: 'Marie' },
            applications: [{ id: 'app-filled-1' }],
          },
        ]) // offersToAutoStart
        .mockResolvedValueOnce([]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.IN_PROGRESS },
        }),
      );
      expect(prisma.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: ApplicationStatus.STARTED },
        }),
      );
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+5555',
        'autoStarted',
        expect.any(Object),
        'emp-filled',
      );
    });

    it('auto-starts PARTIALLY_FILLED offers that have accepted workers', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-partial',
            title: 'Partial',
            employer_id: 'emp-partial',
            employer: { phone: '+6666', first_name: 'Paul' },
            applications: [{ id: 'app-partial-1' }],
          },
        ]) // offersToAutoStart
        .mockResolvedValueOnce([]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.IN_PROGRESS },
        }),
      );
    });

    it('does not double-enqueue reminder_start for auto-started offers', async () => {
      // notifyAutoStartedOffer should NOT enqueue reminder_start;
      // the scan's start window is the only producer of those jobs.
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-filled',
            title: 'Filled',
            employer_id: 'emp-filled',
            payment_flow: 'DAILY',
            employer: { phone: '+5555', first_name: 'Marie' },
            applications: [{ id: 'app-filled-1' }],
          },
        ]) // offersToAutoStart
        .mockResolvedValueOnce([]) // openOverdue
        .mockResolvedValueOnce([]); // start window — no additional offers
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      const startJobs = queueService.addJob.mock.calls.filter(
        (call: unknown[]) =>
          (call[1] as { type: string })?.type === 'reminder_start',
      );
      // No start-window offers match, so zero reminder_start jobs expected
      expect(startJobs).toHaveLength(0);
    });

    it('does NOT deduct reliability score when FILLED offer reaches scheduled_at', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-filled',
            title: 'Filled',
            employer_id: 'emp-filled',
            employer: { phone: '+2222', first_name: 'Alice' },
            applications: [{ id: 'app-1' }],
          },
        ]) // offersToAutoStart — no penalty
        .mockResolvedValueOnce([]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('skips notification if employer phone is missing', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([
          {
            id: 'offer-3',
            title: 'No phone',
            employer_id: 'emp-3',
            employer: { phone: null, first_name: 'X' },
          },
        ]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('handles transaction failure gracefully', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([
          {
            id: 'offer-fail',
            title: 'Fail',
            employer_id: 'emp-fail',
            employer: { phone: '+4444', first_name: 'Dave' },
          },
        ]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);
      prisma.$transaction.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        processor.process({ data: { type: 'scan' } }),
      ).rejects.toThrow('DB error');
    });

    it('does nothing when there are no overdue offers', async () => {
      prisma.jobOffer.findMany.mockResolvedValue([]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });
      expect(prisma.jobOffer.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── sendReminder24h() ────────────────────────────────────────────────────

  describe('in-app first, WhatsApp switched off', () => {
    let events: { emit: jest.Mock };
    let dispatcher: { send: jest.Mock };

    beforeEach(() => {
      events = { emit: jest.fn() };
      // The switch lives in the dispatcher: off means nothing goes out.
      dispatcher = {
        send: jest.fn().mockResolvedValue({ mode: 'TEMPLATE', sent: false }),
      };
      (processor as any).dispatcher = dispatcher;
      (processor as any).events = events;
    });

    it('puts the day-before reminder in the bell, deduplicated', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });

      const [payload] = inAppNotifications(events.emit, 'MISSION_REMINDER');
      expect(payload).toMatchObject({
        input: { when: 'TOMORROW', applicationId: 'app-1' },
      });
      expect(payload.dedupeKey).toContain('app-1');
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('tells applicants and the employer in-app when an offer expires', async () => {
      prisma.jobOffer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'offer-1',
          title: 'Ménage',
          employer_id: 'emp-1',
          employer: { phone: null, first_name: 'Bob' },
          applications: [
            {
              id: 'app-a',
              worker: { id: 'worker-a', phone: null, first_name: 'Awa' },
            },
          ],
        },
      ]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      const expired = inAppNotifications(events.emit, 'JOB_OFFER_EXPIRED');
      expect(
        expired.map((p) => [p.recipientId, (p.input as any).recipientRole]),
      ).toEqual(
        expect.arrayContaining([
          ['emp-1', 'EMPLOYER'],
          ['worker-a', 'WORKER'],
        ]),
      );
    });
  });

  describe('sendReminder24h()', () => {
    it('sends WhatsApp message and sets redis key', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });

      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+1234567890',
        expect.any(String),
        expect.any(Object),
        // The worker id now rides along so the reminder lands in the
        // conversation history, not only in the delivery log.
        expect.any(String),
      );
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('app-1'),
        '1',
        'EX',
        expect.any(Number),
        'NX',
      );
    });

    it('skips if redis key already set (already sent)', async () => {
      redis.set.mockResolvedValueOnce(null); // NX returns null when key exists

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('skips if application not found', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'missing' },
      });
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('skips if worker has no phone', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ worker: { phone: null } }),
      );

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('skips if application status is not ACCEPTED', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ status: ApplicationStatus.PENDING }),
      );

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    // Regression: this used to arm the cancel flow so a "1 = cancel / 2 = keep"
    // quick reply had somewhere to land. The template now carries a single CTA
    // button and shows no menu, so any state armed here turned the worker's
    // next message — "Le rendez vous c'est pour 10h, et non 9h" — into a
    // cancellation. Nothing may arm a flow the worker was never offered.
    it('arms no bot state for the worker after sending', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });

      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
      const botStateCall = redis.set.mock.calls.find((call: unknown[]) =>
        String(call[0]).includes('bot:state:'),
      );
      expect(botStateCall).toBeUndefined();
    });
  });

  // ─── sendReminderStart() ──────────────────────────────────────────────────

  describe('sendReminderStart()', () => {
    it('marks application as STARTED, sends WhatsApp message and sets redis key', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      prisma.application.update = jest.fn().mockResolvedValue({});
      prisma.jobOffer.update = jest.fn().mockResolvedValue({});

      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });

      expect(prisma.application.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: { status: ApplicationStatus.STARTED },
        }),
      );
      expect(prisma.jobOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'offer-1' },
          data: { status: JobOfferStatus.IN_PROGRESS },
        }),
      );
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+1234567890',
        'reminderStart',
        expect.any(Object),
        expect.any(String),
      );
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('app-1'),
        '1',
        'EX',
        expect.any(Number),
        'NX',
      );
    });

    it('skips if redis key already set', async () => {
      redis.set.mockResolvedValueOnce(null); // NX returns null when key exists

      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application not found', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await processor.process({
        data: { type: 'reminder_start', applicationId: 'missing' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if worker has no phone', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ worker: { phone: null } }),
      );

      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application status is not ACCEPTED', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ status: ApplicationStatus.CANCELLED }),
      );

      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  // ─── sendJobStatusCheckReminder() ────────────────────────────────────────────

  describe('sendJobStatusCheckReminder()', () => {
    it('asks the WORKER, not the employer — completion is theirs to confirm', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.IN_PROGRESS,
        title: 'Test Job',
      });
      prisma.application.findUnique.mockResolvedValue({
        status: ApplicationStatus.STARTED,
        worker_id: 'worker-1',
        worker: { phone: '+242000002' },
      });
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242000002',
        'statusCheck',
        expect.any(Object),
        'worker-1',
      );
    });

    it('stops chasing a worker who has already confirmed', async () => {
      // Their application leaves ACCEPTED/STARTED the moment they confirm;
      // re-pinging them after that is noise.
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.IN_PROGRESS,
        title: 'Test Job',
      });
      prisma.application.findUnique.mockResolvedValue({
        status: ApplicationStatus.END,
        worker_id: 'worker-1',
        worker: { phone: '+242000002' },
      });
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    });

    it('skips when offer is not IN_PROGRESS', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.COMPLETED,
        title: 'Test Job',
        employer: { phone: '+242000001' },
      });
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips when offer not found', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue(null);
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips when employer has no phone', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.IN_PROGRESS,
        title: 'Test Job',
        employer: { phone: null },
      });
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    // The snooze state went with the in-chat menu: the status-check template
    // carries a CTA button and never printed "2 = remind me later", so an armed
    // flow could only misread whatever the worker wrote next.
    it('arms no bot state for the worker', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.IN_PROGRESS,
        title: 'Test Job',
      });
      prisma.application.findUnique.mockResolvedValue({
        status: ApplicationStatus.STARTED,
        worker_id: 'worker-1',
        worker: { phone: '+242000002' },
      });

      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });

      const wroteState = [
        ...redis.eval.mock.calls,
        ...redis.set.mock.calls,
      ].some((call: unknown[]) =>
        call.some((arg) => String(arg).includes('bot:state:')),
      );
      expect(wroteState).toBe(false);
    });

    it('handles whatsApp.sendTextMessage failure gracefully', async () => {
      prisma.jobOffer.findUnique = jest.fn().mockResolvedValue({
        status: JobOfferStatus.IN_PROGRESS,
        title: 'Test Job',
        employer: { phone: '+242000001' },
      });
      whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('send failed'),
      );
      await processor.process({
        data: {
          type: 'reminder_job_status',
          jobOfferId: 'offer-1',
          employerId: 'emp-1',
          applicationId: 'app-1',
          paymentFlow: 'DAILY',
        },
      });
      // Should not throw
      expect(true).toBe(true);
    });
  });

  // ─── auto-start employer notification branches ──────────────────────────────

  describe('auto-start employer notification branches', () => {
    it('handles sendTextMessage failure for auto-start employer notification', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-auto',
            title: 'AutoStart',
            employer_id: 'emp-auto',
            payment_flow: 'DAILY',
            employer: { phone: '+9999', first_name: 'Marie' },
            applications: [{ id: 'app-auto' }],
          },
        ]) // offersToAutoStart
        .mockResolvedValueOnce([]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);
      whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('WhatsApp failure'),
      );
      // should not throw
      await expect(
        processor.process({ data: { type: 'scan' } }),
      ).resolves.not.toThrow();
    });
  });

  // ─── expirePendingAttemptsForJob catch branch ─────────────────────────────────

  describe('expirePendingAttemptsForJob catch branch in runScan()', () => {
    it('catches expirePendingAttemptsForJob error and continues', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([]) // openOverdue
        .mockResolvedValueOnce([
          { id: 'offer-start', applications: [{ id: 'app-start-1' }] },
        ]); // start window
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);
      const contactUnlockService = (processor as any).contactUnlockService;
      contactUnlockService.expirePendingAttemptsForJob = jest
        .fn()
        .mockRejectedValueOnce(new Error('Unlock error'));
      await processor.process({ data: { type: 'scan' } });
      // Should not throw
      expect(true).toBe(true);
    });

    it('sends credit conversion notifications when conversions exist', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([]) // openOverdue
        .mockResolvedValueOnce([
          { id: 'offer-start', applications: [{ id: 'app-start-1' }] },
        ]); // start window
      prisma.application.findMany.mockResolvedValue([] as never);
      redis.get.mockResolvedValue(null);
      const contactUnlockService = (processor as any).contactUnlockService;
      contactUnlockService.expirePendingAttemptsForJob = jest
        .fn()
        .mockResolvedValue([{ profileId: 'p-1', amount: 5000 }]);
      const botNotification = (processor as any).botNotification;
      botNotification.sendContactUnlockCreditConversionNotification = jest
        .fn()
        .mockResolvedValue(undefined);
      await processor.process({ data: { type: 'scan' } });
      expect(
        botNotification.sendContactUnlockCreditConversionNotification,
      ).toHaveBeenCalledWith('p-1', 5000);
    });
  });

  // ─── expired offer notification error branch ────────────────────────────────

  describe('expired offer notification failure in expireOverdueOffers()', () => {
    it('handles sendTextMessage failure for expired offer notification', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // offersToAutoStart
        .mockResolvedValueOnce([
          {
            id: 'offer-expired',
            title: 'Expired Offer',
            employer_id: 'emp-expired',
            employer: { phone: '+9876', first_name: 'X' },
          },
        ]); // openOverdue
      prisma.application.findMany.mockResolvedValue([] as never);
      whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('send failed'),
      );
      await processor.process({ data: { type: 'scan' } });
      // Should not throw; redis.set not called since sent=false
      expect(true).toBe(true);
    });
  });

  // ─── sendReminderStart() error path ─────────────────────────────────────────

  describe('sendReminderStart() error path', () => {
    it('rolls back application status when whatsApp.sendTemplateMessage throws', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      prisma.application.update = jest.fn().mockResolvedValue({});
      prisma.jobOffer.update = jest.fn().mockResolvedValue({});
      whatsApp.sendTemplateMessage.mockRejectedValueOnce(
        new Error('WhatsApp error'),
      );
      redis.set = jest.fn().mockResolvedValue('OK'); // claim succeeds
      redis.del = jest.fn().mockResolvedValue(1);
      await expect(
        processor.process({
          data: { type: 'reminder_start', applicationId: 'app-1' },
        }),
      ).rejects.toThrow('WhatsApp error');
      expect(redis.del).toHaveBeenCalled();
    });
  });
});
