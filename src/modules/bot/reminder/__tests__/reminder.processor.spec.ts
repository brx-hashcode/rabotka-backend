import { Logger } from '@nestjs/common';
import { ReminderProcessor } from '../reminder.processor';
import { ApplicationStatus, JobOfferStatus } from '@prisma/client';
import type { SystemConfigService } from '../../../system-config/system-config.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const buildApplication = (overrides: Record<string, unknown> = {}) => ({
  id: 'app-1',
  job_offer_id: 'offer-1',
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
    whatsApp = { sendTextMessage: jest.fn().mockResolvedValue(undefined) };
    queueService = { addJob: jest.fn().mockResolvedValue('job-1') };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    systemConfigService = {
      getFees: jest.fn().mockResolvedValue({
        lateCancellationPenaltyFcfa: 5000,
        lateCancellationScoreDeduction: 5,
        cancellationThresholdHours: 4,
        reliabilityScoreMin: 50,
        employerCancelScoreDeduction: 5,
        employerGhostScoreDeduction: 10,
        billingBlockThreshold: 2,
      }),
    } as any;
    processor = new ReminderProcessor(
      prisma,
      whatsApp,
      queueService,
      redis,
      systemConfigService,
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
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('delegates to sendReminder2h for type=reminder_2h', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('delegates to sendReminderStart for type=reminder_start', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());
      await processor.process({
        data: { type: 'reminder_start', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
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
      prisma.application.findMany
        .mockResolvedValueOnce([{ id: 'app-24h' }]) // 24h window
        .mockResolvedValueOnce([]) // 2h window
        .mockResolvedValueOnce([]); // start window
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      redis.get.mockResolvedValue('1');

      await processor.process({ data: { type: 'scan' } });
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it('enqueues reminder_2h jobs for apps not yet notified', async () => {
      prisma.application.findMany
        .mockResolvedValueOnce([]) // 24h window
        .mockResolvedValueOnce([{ id: 'app-2h' }]) // 2h window
        .mockResolvedValueOnce([]); // start window
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        { type: 'reminder_2h', applicationId: 'app-2h' },
        { jobId: '2h-app-2h' },
      );
    });

    it('enqueues reminder_start jobs for apps whose scheduled_at just passed', async () => {
      prisma.application.findMany
        .mockResolvedValueOnce([]) // 24h window
        .mockResolvedValueOnce([]) // 2h window
        .mockResolvedValueOnce([{ id: 'app-start' }]); // start window
      redis.get.mockResolvedValue(null);

      await processor.process({ data: { type: 'scan' } });

      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        { type: 'reminder_start', applicationId: 'app-start' },
        { jobId: 'start-app-start' },
      );
    });

    it('skips reminder_start if redis key already set', async () => {
      prisma.application.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'app-start' }]);
      redis.get.mockResolvedValue('1');

      await processor.process({ data: { type: 'scan' } });
      expect(queueService.addJob).not.toHaveBeenCalled();
    });
  });

  // ─── expireOverdueOffers() ────────────────────────────────────────────────

  describe('expireOverdueOffers() via scan', () => {
    it('marks overdue open offers as EXPIRED', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-1',
            title: 'Test',
            employer_id: 'emp-1',
            employer: {
              phone: '+1111',
              first_name: 'Bob',
              reliability_score: 100,
            },
          },
        ])
        .mockResolvedValueOnce([]); // no filled overdue
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.jobOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.EXPIRED },
        }),
      );
    });

    it('deducts reliability score for ghost employers (FILLED overdue)', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([]) // open overdue
        .mockResolvedValueOnce([
          {
            id: 'offer-ghost',
            title: 'Ghost',
            employer_id: 'emp-ghost',
            employer: {
              phone: '+2222',
              first_name: 'Alice',
              reliability_score: 100,
            },
          },
        ]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'emp-ghost' },
          data: {
            reliability_score: Math.max(50, 100 - 10),
          },
        }),
      );
    });

    it('does not deduct below RELIABILITY_SCORE_MIN', async () => {
      prisma.jobOffer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'offer-2',
          title: 'Low',
          employer_id: 'emp-2',
          employer: {
            phone: '+3333',
            first_name: 'Charlie',
            reliability_score: 51,
          },
        },
      ]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });

      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { reliability_score: 50 },
        }),
      );
    });

    it('skips notification if employer phone is missing', async () => {
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([
          {
            id: 'offer-3',
            title: 'No phone',
            employer_id: 'emp-3',
            employer: { phone: null, first_name: 'X' },
          },
        ])
        .mockResolvedValueOnce([]);
      prisma.application.findMany.mockResolvedValue([] as never);

      await processor.process({ data: { type: 'scan' } });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('handles gracefully when score deduction fails', async () => {
      prisma.jobOffer.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: 'offer-fail',
          title: 'Fail',
          employer_id: 'emp-fail',
          employer: {
            phone: '+4444',
            first_name: 'Dave',
            reliability_score: 80,
          },
        },
      ]);
      prisma.application.findMany.mockResolvedValue([] as never);
      prisma.$transaction.mockRejectedValueOnce(new Error('DB error'));
      jest.spyOn(Logger.prototype, 'warn');

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

  describe('sendReminder24h()', () => {
    it('sends WhatsApp message and sets redis key', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });

      expect(whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+1234567890',
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
      redis.get.mockResolvedValue('1');

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application not found', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'missing' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if worker has no phone', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ worker: { phone: null } }),
      );

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application status is not ACCEPTED', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ status: ApplicationStatus.PENDING }),
      );

      await processor.process({
        data: { type: 'reminder_24h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  // ─── sendReminder2h() ────────────────────────────────────────────────────

  describe('sendReminder2h()', () => {
    it('sends WhatsApp message and sets redis key', async () => {
      prisma.application.findUnique.mockResolvedValue(buildApplication());

      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'app-1' },
      });

      expect(whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+1234567890',
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
      redis.get.mockResolvedValue('1');

      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application not found', async () => {
      prisma.application.findUnique.mockResolvedValue(null);

      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'missing' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if worker has no phone', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ worker: { phone: null } }),
      );

      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
    });

    it('skips if application status is not ACCEPTED', async () => {
      prisma.application.findUnique.mockResolvedValue(
        buildApplication({ status: ApplicationStatus.PENDING }),
      );

      await processor.process({
        data: { type: 'reminder_2h', applicationId: 'app-1' },
      });
      expect(whatsApp.sendTextMessage).not.toHaveBeenCalled();
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
      expect(whatsApp.sendTextMessage).toHaveBeenCalledWith(
        '+1234567890',
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
      redis.get.mockResolvedValue('1');

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
});
