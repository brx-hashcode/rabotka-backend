import { AdminCacheService } from '../../../common/services/cache/admin-cache.service';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationService } from '../application.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { ContractService } from '../../contract/contract.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { MatchingService } from '../../matching/matching.service';
import { InteractionEventService } from '../../recommendation-engine/interaction-event.service';
import { JobEventsGateway } from '../../ws-notifications/job-events.gateway';
import {
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
  PaymentFlow,
} from '@prisma/client';
import { LATE_CANCELLATION_PENALTY_FCFA } from '../application.constants';

const JOB_OFFER_ID = 'offer-uuid-1';
const WORKER_ID = 'worker-uuid-1';
const EMPLOYER_ID = 'employer-uuid-1';
const APPLICATION_ID = 'app-uuid-1';

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

const mockJobOffer = {
  id: JOB_OFFER_ID,
  title: 'Plombier',
  description: 'Réparation urgente',
  scheduled_at: hoursFromNow(5),
  amount: 15000,
  payment_flow: PaymentFlow.DAILY,
  employment_type: EmploymentType.MISSION,
  address: '123 Avenue de la Paix',
  note: null,
  quantity: 1,
  status: JobOfferStatus.ACTIVE,
  employer_id: EMPLOYER_ID,
  created_at: new Date(),
  updated_at: new Date(),
  employer: {
    id: EMPLOYER_ID,
    first_name: 'John',
    last_name: 'Doe',
    phone: '+242000000',
    email: 'employer@test.com',
    profile_type: 'EMPLOYER',
    status: 'ACTIVE',
  },
};

const mockWorker = {
  id: WORKER_ID,
  status: 'ACTIVE',
  profile_type: 'WORKER',
  verification_status: 'VERIFIED',
};

const mockApplication = {
  id: APPLICATION_ID,
  job_offer_id: JOB_OFFER_ID,
  worker_id: WORKER_ID,
  status: ApplicationStatus.PENDING,
  cancelled_at: null,
  cancellation_reason: null,
  penalty_applied: false,
  penalty_amount: null,
  created_at: new Date(),
  updated_at: new Date(),
  job_offer: mockJobOffer,
  worker: {
    id: WORKER_ID,
    first_name: 'Jane',
    last_name: 'Doe',
    phone: '+242111111',
    email: 'worker@test.com',
    description: 'Worker description',
    reliability_score: 100,
    verification_status: 'VERIFIED',
    avatar_url: null,
  },
};

describe('ApplicationService', () => {
  let service: ApplicationService;
  let prisma: jest.Mocked<PrismaService>;
  let botNotification: jest.Mocked<BotNotificationService>;
  let testingModule: TestingModule;

  beforeEach(async () => {
    const mockPrismaService = {
      jobOffer: { findUnique: jest.fn(), update: jest.fn() },
      profile: { findUnique: jest.fn(), update: jest.fn() },
      penalty: {
        count: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
      },
      application: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      payment: { create: jest.fn() },
      assignment: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      rating: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { score: 4.5 }, _count: { score: 4 } }),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
      $transaction: jest.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') {
          // Interactive transaction: call with mockPrismaService as tx
          return arg(mockPrismaService);
        }
        // Array transaction: resolve with empty results
        return Promise.resolve([]);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          // Pass-through cache: the loader always runs, so these specs keep
          // exercising the real queries rather than a cached value.
          provide: AdminCacheService,
          useValue: {
            wrap: (_k: string, _t: number, loader: () => unknown) => loader(),
            listKey: (e: string) => e,
            dashboardKey: (e: string) => e,
            invalidate: jest.fn(),
          },
        },
        ApplicationService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: BotNotificationService,
          useValue: {
            sendNewApplicationToEmployer: jest
              .fn()
              .mockResolvedValue(undefined),
            sendApplicationAcceptedToWorker: jest
              .fn()
              .mockResolvedValue(undefined),
            sendApplicationRejectedToWorker: jest
              .fn()
              .mockResolvedValue(undefined),
            sendCancellationToEmployer: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: ContactUnlockService,
          useValue: { initiateUnlock: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ContractService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SystemConfigService,
          useValue: {
            getFees: jest.fn().mockResolvedValue({
              contactUnlockFee: 500,
              cancellationThresholdHours: 4,
              lateCancellationPenaltyFcfa: LATE_CANCELLATION_PENALTY_FCFA,
              lateCancellationScoreDeduction: 5,
              reliabilityScoreMin: 50,
              employerLateCancelScoreDeduction: 5,
              billingBlockThreshold: 2,
              maxDailyApplications: 10,
              completionScoreReward: 1,
              ratingScoreDeltas: { 1: -4, 2: -2, 3: 0, 4: 1, 5: 3 },
            }),
          },
        },
        {
          provide: MatchingService,
          useValue: {
            refreshMatchesForJobOffer: jest.fn().mockResolvedValue(undefined),
            indexWorkerProfile: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          // Push that keeps the counterparty's screen in sync; irrelevant to
          // these assertions, but the service depends on it.
          provide: JobEventsGateway,
          useValue: { emitJobChanged: jest.fn() },
        },
        {
          provide: InteractionEventService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
            recordMany: jest.fn().mockResolvedValue(0),
          },
        },
      ],
    }).compile();

    service = module.get<ApplicationService>(ApplicationService);
    prisma = module.get(PrismaService);
    botNotification = module.get(BotNotificationService);
    testingModule = module;
  });

  describe('rejectPendingApplicants()', () => {
    it('rejects PENDING/VIEWED/WAITING_PAYMENT applicants and returns their ids', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValueOnce([
        { id: 'a1' },
        { id: 'a2' },
      ]);

      const ids = await service.rejectPendingApplicants(JOB_OFFER_ID);

      expect(ids).toEqual(['a1', 'a2']);
      expect(prisma.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['a1', 'a2'] } },
          data: expect.objectContaining({
            status: ApplicationStatus.REJECTED,
            // Must be AUTO_FILL: these applicants were closed out because the
            // offer is no longer open, not turned down. Marking them EMPLOYER
            // would feed the recommender false negatives and eventually ban a
            // worker from their own trade.
            rejection_source: 'AUTO_FILL',
            rejected_at: expect.any(Date),
          }),
        }),
      );
    });

    it('is a no-op (no update) when there are no leftover applicants', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValueOnce([]);

      const ids = await service.rejectPendingApplicants(JOB_OFFER_ID);

      expect(ids).toEqual([]);
      expect(prisma.application.updateMany).not.toHaveBeenCalled();
    });

    it('excludes the given application id from rejection', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValueOnce([]);

      await service.rejectPendingApplicants(JOB_OFFER_ID, {
        excludeApplicationId: APPLICATION_ID,
      });

      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { not: APPLICATION_ID },
          }),
        }),
      );
    });

    it('notifyRejectedApplicants sends a rejection to each worker', () => {
      service.notifyRejectedApplicants(['a1', 'a2']);
      expect(
        botNotification.sendApplicationRejectedToWorker,
      ).toHaveBeenCalledWith('a1');
      expect(
        botNotification.sendApplicationRejectedToWorker,
      ).toHaveBeenCalledWith('a2');
    });
  });

  describe('applyRatingToReliability()', () => {
    const makeTx = (currentScore: number | null) => ({
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ reliability_score: currentScore }),
        update: jest.fn().mockResolvedValue({}),
      },
    });

    it('raises the score by the 5★ delta (clamped at 100)', async () => {
      const tx = makeTx(98);
      await service.applyRatingToReliability(tx as any, WORKER_ID, 5); // +3 → 100
      expect(tx.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WORKER_ID },
          data: { reliability_score: 100 },
        }),
      );
    });

    it('lowers the score by the 1★ delta (clamped at floor 50)', async () => {
      const tx = makeTx(52);
      await service.applyRatingToReliability(tx as any, WORKER_ID, 1); // -4 → 50 (floor)
      expect(tx.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { reliability_score: 50 },
        }),
      );
    });

    it('does nothing for a neutral 3★ (delta 0)', async () => {
      const tx = makeTx(80);
      await service.applyRatingToReliability(tx as any, WORKER_ID, 3);
      expect(tx.profile.update).not.toHaveBeenCalled();
    });
  });

  describe('rateAssignment()', () => {
    const ASSIGNMENT_ID = 'assign-uuid-1';
    const completedAssignment = {
      status: 'COMPLETED',
      worker_id: WORKER_ID,
      job_offer: { employer_id: EMPLOYER_ID },
    };

    it('feeds the worker reliability when the employer rates on first rating', async () => {
      (prisma.assignment.findUnique as jest.Mock).mockResolvedValueOnce(
        completedAssignment,
      );
      (prisma.rating.findUnique as jest.Mock).mockResolvedValueOnce(null);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValueOnce({
        reliability_score: 90,
      });

      await service.rateAssignment(ASSIGNMENT_ID, EMPLOYER_ID, 5); // +3

      expect(prisma.rating.upsert).toHaveBeenCalled();
      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: WORKER_ID },
          data: { reliability_score: 93 },
        }),
      );
    });

    it('does NOT feed reliability on a re-rating (already rated)', async () => {
      (prisma.assignment.findUnique as jest.Mock).mockResolvedValueOnce(
        completedAssignment,
      );
      (prisma.rating.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'existing',
      });

      await service.rateAssignment(ASSIGNMENT_ID, EMPLOYER_ID, 2);

      // Only the ratee-aggregate profile.update runs, never a reliability bump.
      const reliabilityUpdate = (
        prisma.profile.update as jest.Mock
      ).mock.calls.find((c) => c[0]?.data?.reliability_score !== undefined);
      expect(reliabilityUpdate).toBeUndefined();
    });

    it('does NOT feed reliability when the worker rates the employer', async () => {
      (prisma.assignment.findUnique as jest.Mock).mockResolvedValueOnce(
        completedAssignment,
      );
      (prisma.rating.findUnique as jest.Mock).mockResolvedValueOnce(null);

      await service.rateAssignment(ASSIGNMENT_ID, WORKER_ID, 5);

      const reliabilityUpdate = (
        prisma.profile.update as jest.Mock
      ).mock.calls.find((c) => c[0]?.data?.reliability_score !== undefined);
      expect(reliabilityUpdate).toBeUndefined();
    });

    it('rejects a rater who is neither the worker nor the employer', async () => {
      (prisma.assignment.findUnique as jest.Mock).mockResolvedValueOnce(
        completedAssignment,
      );
      await expect(
        service.rateAssignment(ASSIGNMENT_ID, 'stranger', 4),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when the assignment is not yet completed', async () => {
      (prisma.assignment.findUnique as jest.Mock).mockResolvedValueOnce({
        ...completedAssignment,
        status: 'CONFIRMED',
      });
      await expect(
        service.rateAssignment(ASSIGNMENT_ID, EMPLOYER_ID, 4),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a score outside 1–5', async () => {
      await expect(
        service.rateAssignment(ASSIGNMENT_ID, EMPLOYER_ID, 6),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('create()', () => {
    beforeEach(() => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockJobOffer);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockWorker);
      (prisma.penalty.count as jest.Mock).mockResolvedValue(0);
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      (prisma.application.create as jest.Mock).mockResolvedValue({
        ...mockApplication,
        job_offer: mockJobOffer,
      });
    });

    it('notifies the employer exactly once, whatever the channel', async () => {
      // This used to fire only from the WhatsApp apply flow, so a worker
      // applying on the web produced no notification at all. It lives here now,
      // and the bot flow no longer calls it — so exactly one is sent either way.
      await service.create(JOB_OFFER_ID, WORKER_ID);
      expect(
        botNotification.sendNewApplicationToEmployer,
      ).toHaveBeenCalledTimes(1);
      expect(botNotification.sendNewApplicationToEmployer).toHaveBeenCalledWith(
        APPLICATION_ID,
      );
    });

    it('still returns the application when the notification fails', async () => {
      botNotification.sendNewApplicationToEmployer.mockRejectedValue(
        new Error('twilio down'),
      );
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).resolves.toEqual(
        expect.objectContaining({ id: APPLICATION_ID }),
      );
    });

    it('creates a valid application', async () => {
      const result = await service.create(JOB_OFFER_ID, WORKER_ID);
      expect(result.id).toBe(APPLICATION_ID);
      expect(result.status).toBe(ApplicationStatus.PENDING);
    });

    it('throws ForbiddenException when worker has unpaid penalties', async () => {
      (prisma.penalty.count as jest.Mock).mockResolvedValue(1);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when worker applies to own offer', async () => {
      const offerOwnedByWorker = { ...mockJobOffer, employer_id: WORKER_ID };
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(
        offerOwnedByWorker,
      );
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a worker whose KYC is not verified', async () => {
      // Mirrors KycVerifiedGuard: enforced here too because the WhatsApp bot
      // reaches this service without passing through any HTTP guard.
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        ...mockWorker,
        verification_status: 'PENDING',
      });
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ConflictException when worker already applied', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws ForbiddenException at the daily cap', async () => {
      // The daily cap is the only gate now. The concurrent-slot cap is gone —
      // it was the binding one and nothing cleared it on a clock, so a worker
      // with open applications was blocked until an employer responded.
      (prisma.application.count as jest.Mock).mockResolvedValue(10);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('does not block a worker who already has open applications', async () => {
      // Five open applications used to be a hard stop. Now only today's count
      // matters, and this worker has applied 3 times today against a cap of 10.
      (prisma.application.count as jest.Mock).mockResolvedValue(3);
      await expect(
        service.create(JOB_OFFER_ID, WORKER_ID),
      ).resolves.toBeDefined();
    });

    it('throws BadRequestException when offer is not ACTIVE', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        ...mockJobOffer,
        status: JobOfferStatus.FILLED,
      });
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when offer does not exist', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('cancel()', () => {
    const acceptedApplication = {
      ...mockApplication,
      status: ApplicationStatus.ACCEPTED,
    };

    beforeEach(() => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        acceptedApplication,
      );
      (prisma.jobOffer.update as jest.Mock).mockResolvedValue(mockJobOffer);
      (prisma.application.update as jest.Mock).mockResolvedValue({
        ...acceptedApplication,
        status: ApplicationStatus.CANCELLED,
        cancelled_at: new Date(),
      });
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: WORKER_ID,
        reliability_score: 100,
      });
      (prisma.penalty.create as jest.Mock).mockResolvedValue({});
      (prisma.profile.update as jest.Mock).mockResolvedValue({});
      // Mock findById (used internally)
      jest.spyOn(service, 'findById').mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.CANCELLED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        } as any,
        worker: mockApplication.worker as any,
      } as any);
    });

    it('cancels > 4h before: no penalty applied', async () => {
      // scheduled_at is 5h from now — no penalty
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(false);
      expect(result.penaltyAmount).toBeNull();
      expect(prisma.penalty.create as jest.Mock).not.toHaveBeenCalled();
    });

    it('cancels ACCEPTED application < 4h before: penalty applied', async () => {
      const lateMockOffer = { ...mockJobOffer, scheduled_at: hoursFromNow(2) };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...acceptedApplication,
        job_offer: lateMockOffer,
      });
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(true);
      expect(result.penaltyAmount).toBe(LATE_CANCELLATION_PENALTY_FCFA);
      expect(prisma.penalty.upsert as jest.Mock).toHaveBeenCalled();
    });

    it('cancels PENDING application < 4h before: no penalty (only ACCEPTED triggers penalty)', async () => {
      const lateMockOffer = { ...mockJobOffer, scheduled_at: hoursFromNow(2) };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.PENDING,
        job_offer: lateMockOffer,
      });
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(false);
      expect(prisma.penalty.upsert as jest.Mock).not.toHaveBeenCalled();
    });

    it('reverts offer to ACTIVE when cancelling accepted application', async () => {
      await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(prisma.jobOffer.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.ACTIVE },
        }),
      );
    });

    it('throws BadRequestException when cancelling ACCEPTED application after job has started', async () => {
      const pastOffer = { ...mockJobOffer, scheduled_at: hoursFromNow(-1) };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...acceptedApplication,
        job_offer: pastOffer,
      });
      await expect(service.cancel(APPLICATION_ID, WORKER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows cancelling PENDING application even after scheduled_at has passed (no penalty)', async () => {
      const pastOffer = { ...mockJobOffer, scheduled_at: hoursFromNow(-1) };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.PENDING,
        job_offer: pastOffer,
      });
      // PENDING past-start is allowed (no confirmed acceptance)
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(false);
    });

    it('rejects a concurrent duplicate cancel (already CANCELLED inside tx) without deducting score twice', async () => {
      const lateMockOffer = { ...mockJobOffer, scheduled_at: hoursFromNow(2) };
      // Pre-transaction read sees ACCEPTED (passes outer guard);
      // the locked in-transaction re-read sees CANCELLED.
      (prisma.application.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          ...acceptedApplication,
          job_offer: lateMockOffer,
        })
        .mockResolvedValueOnce({ status: ApplicationStatus.CANCELLED });
      await expect(service.cancel(APPLICATION_ID, WORKER_ID)).rejects.toThrow(
        BadRequestException,
      );
      // Reliability score must NOT be deducted on the duplicate cancel
      expect(prisma.profile.update as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('accept()', () => {
    beforeEach(() => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      jest.spyOn(service, 'findById').mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        } as any,
        worker: mockApplication.worker as any,
      } as any);
    });

    it('quantity=1: first acceptance → offer FILLED', async () => {
      // job has quantity=1, 0 already accepted → 0+1 >= 1 → FILLED
      await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(prisma.jobOffer.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: JobOfferStatus.FILLED } }),
      );
    });

    it('quantity=4: first acceptance → offer becomes PARTIALLY_FILLED', async () => {
      const offerWithQty4 = { ...mockJobOffer, quantity: 4 };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        job_offer: offerWithQty4,
      });
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(prisma.jobOffer.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.PARTIALLY_FILLED },
        }),
      );
    });

    it('quantity=4: fourth acceptance → offer FILLED', async () => {
      const offerWithQty4 = { ...mockJobOffer, quantity: 4 };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        job_offer: offerWithQty4,
      });
      (prisma.application.count as jest.Mock).mockResolvedValue(3);
      await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(prisma.jobOffer.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: JobOfferStatus.FILLED } }),
      );
    });

    it('accepts application and returns ACCEPTED status', async () => {
      const result = await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(result.status).toBe(ApplicationStatus.ACCEPTED);
    });

    it('notifies the accepted worker exactly once', async () => {
      // Only the WhatsApp accept flow used to do this, so accepting on the web
      // left the winner uninformed while the rivals got their rejection.
      await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(
        botNotification.sendApplicationAcceptedToWorker,
      ).toHaveBeenCalledTimes(1);
      expect(
        botNotification.sendApplicationAcceptedToWorker,
      ).toHaveBeenCalledWith(APPLICATION_ID);
    });

    it('still accepts when the notification fails', async () => {
      botNotification.sendApplicationAcceptedToWorker.mockRejectedValue(
        new Error('twilio down'),
      );
      await expect(
        service.accept(APPLICATION_ID, EMPLOYER_ID),
      ).resolves.toEqual(
        expect.objectContaining({ status: ApplicationStatus.ACCEPTED }),
      );
    });

    it('throws ForbiddenException when non-employer tries to accept', async () => {
      await expect(
        service.accept(APPLICATION_ID, 'other-employer-id'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('create() - additional branches', () => {
    beforeEach(() => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockJobOffer);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockWorker);
      (prisma.penalty.count as jest.Mock).mockResolvedValue(0);
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
    });

    it('throws NotFoundException when worker not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockJobOffer);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when worker account not ACTIVE', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        ...mockWorker,
        status: 'SUSPENDED',
      });
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when profile_type is not WORKER', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        ...mockWorker,
        profile_type: 'EMPLOYER',
      });
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('findByWorker()', () => {
    it('returns applications for worker', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const result = await service.findByWorker(WORKER_ID);
      expect(Array.isArray(result)).toBe(true);
    });

    it('filters by status', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      await service.findByWorker(WORKER_ID, {
        status: ApplicationStatus.PENDING,
      });
      expect(prisma.application.findMany as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('findByEmployer()', () => {
    it('returns applications for employer', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const result = await service.findByEmployer(EMPLOYER_ID);
      expect(Array.isArray(result)).toBe(true);
    });

    it('filters by status for employer', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      await service.findByEmployer(EMPLOYER_ID, {
        status: ApplicationStatus.ACCEPTED,
      });
      expect(prisma.application.findMany as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('findByJobOffer()', () => {
    it('returns applications for job offer', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const result = await service.findByJobOffer(JOB_OFFER_ID);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('accept() - additional branches', () => {
    beforeEach(() => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      jest.spyOn(service, 'findById').mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        } as any,
        worker: mockApplication.worker as any,
      } as any);
    });

    it('throws BadRequestException when application status is not PENDING or VIEWED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
      });
      let error: any;
      try {
        await service.accept(APPLICATION_ID, EMPLOYER_ID);
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws ConflictException when capacity is already full', async () => {
      (prisma.application.count as jest.Mock).mockResolvedValue(1); // already 1, quantity is 1
      let error: any;
      try {
        await service.accept(APPLICATION_ID, EMPLOYER_ID);
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(409);
    });
  });

  describe('markAsViewed()', () => {
    it('marks application as viewed', async () => {
      (prisma.application.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      await service.markAsViewed(APPLICATION_ID);
      expect(prisma.application.updateMany as jest.Mock).toHaveBeenCalled();
    });
  });

  describe('getUnpaidPenalties()', () => {
    it('returns count, total, and ids', async () => {
      (prisma.penalty as any).findMany = jest.fn().mockResolvedValue([
        { id: 'p-1', amount: 5000 },
        { id: 'p-2', amount: 3000 },
      ]);
      const result = await service.getUnpaidPenalties(WORKER_ID);
      expect(result.count).toBe(2);
      expect(result.total).toBe(8000);
    });

    it('returns zeros when no penalties', async () => {
      (prisma.penalty as any).findMany = jest.fn().mockResolvedValue([]);
      const result = await service.getUnpaidPenalties(WORKER_ID);
      expect(result.count).toBe(0);
      expect(result.total).toBe(0);
    });
  });

  describe('markCompletedByWorker()', () => {
    /**
     * Completion belongs to the worker now — the employer only rates. Builds a
     * tx double so each test can assert what was written inside the
     * transaction, and control how many co-workers are still outstanding.
     */
    const setupTx = (
      opts: { stillWorking?: number; offerStatus?: string } = {},
    ) => {
      const tx: any = {
        jobOffer: {
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue({
            status: opts.offerStatus ?? JobOfferStatus.IN_PROGRESS,
          }),
        },
        assignment: {
          create: jest.fn().mockResolvedValue({}),
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({}),
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'asg-1', status: 'STARTED' }),
          findUnique: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
        },
        application: {
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({}),
          findMany: jest.fn().mockResolvedValue([]),
          // How many hired workers have NOT finished yet.
          count: jest.fn().mockResolvedValue(opts.stillWorking ?? 0),
        },
        payment: { create: jest.fn().mockResolvedValue({}) },
        profile: {
          findUnique: jest.fn().mockResolvedValue({ reliability_score: 100 }),
          update: jest.fn().mockResolvedValue({}),
        },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      (prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
        typeof fn === 'function' ? fn(tx) : Promise.resolve([]),
      );
      return tx;
    };

    const setupApplication = (status: ApplicationStatus) => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status,
      });
    };

    it('refuses a worker who is not the one on this mission', async () => {
      setupApplication(ApplicationStatus.ACCEPTED);
      setupTx();

      await expect(
        service.markCompletedByWorker(APPLICATION_ID, 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('ends the worker own application', async () => {
      setupApplication(ApplicationStatus.ACCEPTED);
      const tx = setupTx();

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(tx.application.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: APPLICATION_ID },
          data: { status: ApplicationStatus.END },
        }),
      );
    });

    it('works from STARTED too', async () => {
      setupApplication(ApplicationStatus.STARTED);
      const tx = setupTx();

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(tx.assignment.update).toHaveBeenCalled();
    });

    it('closes the offer once no hired worker is left outstanding', async () => {
      setupApplication(ApplicationStatus.ACCEPTED);
      const tx = setupTx({ stillWorking: 0 });

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(tx.jobOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.COMPLETED },
        }),
      );
    });

    it('leaves the offer open while a co-worker is still going', async () => {
      // The whole reason completion is per-worker: an offer can hire several
      // people, and the first to finish must not end everyone else's mission.
      setupApplication(ApplicationStatus.ACCEPTED);
      const tx = setupTx({ stillWorking: 1 });

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(tx.jobOffer.update).not.toHaveBeenCalled();
    });

    it('pushes to BOTH parties, not just the one who acted', async () => {
      // The employer's rating action only becomes available once the worker
      // confirms, and their screen has no other way to learn that:
      // invalidateQueries runs in the worker's browser, not theirs. Inside
      // WhatsApp's webview it never self-corrects either — no focus or
      // reconnect events fire there.
      setupApplication(ApplicationStatus.ACCEPTED);
      setupTx();
      const gateway = testingModule.get(JobEventsGateway);

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(gateway.emitJobChanged).toHaveBeenCalledWith(
        expect.arrayContaining([WORKER_ID, EMPLOYER_ID]),
        expect.objectContaining({ kind: 'completed' }),
      );
    });

    it.each([EmploymentType.CDI, EmploymentType.CDD, EmploymentType.STAGE])(
      'refuses to complete a %s — it is not a one-off gig',
      async (type) => {
        // A permanent or fixed-term engagement has no moment to confirm. Offering
        // "terminer" there would be misleading, and the error names the type so
        // the caller can tell this from an ordinary state error.
        (prisma.application.findUnique as jest.Mock).mockResolvedValue({
          ...mockApplication,
          status: ApplicationStatus.ACCEPTED,
          job_offer: { ...mockJobOffer, employment_type: type },
        });
        setupTx();

        await expect(
          service.markCompletedByWorker(APPLICATION_ID, WORKER_ID),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('records no payment — Rabotka never touches the wage', async () => {
      // The employer pays the worker directly. Recording the wage as a Payment
      // invented a transaction that never happened and, because the revenue
      // queries summed every COMPLETED payment, booked the worker's whole wage
      // as platform revenue.
      setupApplication(ApplicationStatus.ACCEPTED);
      const tx = setupTx();

      await service.markCompletedByWorker(APPLICATION_ID, WORKER_ID);

      expect(tx.payment.create).not.toHaveBeenCalled();
    });
  });
});
