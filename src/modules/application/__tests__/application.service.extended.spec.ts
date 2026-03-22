import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationService } from '../application.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { ApplicationStatus, JobOfferStatus, PaymentFlow } from '@prisma/client';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { QdrantService } from '../../qdrant/qdrant.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';

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
  description: 'Réparation urgente longue description qui passe la validation',
  scheduled_at: hoursFromNow(5),
  amount: 15000,
  payment_flow: PaymentFlow.DAILY,
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
  },
};

const mockWorkerProfile = {
  id: WORKER_ID,
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+242111111',
  email: 'worker@test.com',
  description: 'Worker description',
  reliability_score: 100,
  verification_status: 'VERIFIED',
  avatar_url: null,
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
  worker: mockWorkerProfile,
};

describe('ApplicationService (extended)', () => {
  let service: ApplicationService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      jobOffer: { findUnique: jest.fn(), update: jest.fn() },
      profile: { findUnique: jest.fn(), update: jest.fn() },
      penalty: {
        count: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      application: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      payment: { create: jest.fn() },
      assignment: { create: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') {
          return arg(mockPrismaService);
        }
        return Promise.resolve([]);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: BotNotificationService, useValue: { notifyApplicationAccepted: jest.fn(), notifyApplicationRejected: jest.fn(), notifyApplicationCancelled: jest.fn(), notifyEmployerNewApplication: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue('0'), getFees: jest.fn().mockResolvedValue({ jobPostingFeeFcfa: 0, maxConcurrentApplications: 2 }), getCancellationSettings: jest.fn().mockResolvedValue({ lateCancellationPenaltyFcfa: 5000, lateCancellationScoreDeduction: 10, cancellationThresholdHours: 4 }) } },
        { provide: QdrantService, useValue: { search: jest.fn().mockResolvedValue([]), upsert: jest.fn(), delete: jest.fn(), setPayload: jest.fn().mockResolvedValue(undefined) } },
        { provide: WhatsAppService, useValue: { sendTextMessage: jest.fn().mockResolvedValue(true) } },
      ],
    }).compile();

    service = module.get<ApplicationService>(ApplicationService);
    prisma = module.get(PrismaService);
  });

  describe('reject()', () => {
    beforeEach(() => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      (prisma.application.update as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.REJECTED,
      });
    });

    it('rejects application successfully', async () => {
      const result = await service.reject(APPLICATION_ID, EMPLOYER_ID);
      expect(result.status).toBe(ApplicationStatus.REJECTED);
    });

    it('throws NotFoundException when application not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.reject(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not the employer', async () => {
      await expect(
        service.reject(APPLICATION_ID, 'other-employer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when application is not PENDING/VIEWED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
      });
      await expect(
        service.reject(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects VIEWED application', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.VIEWED,
      });
      (prisma.application.update as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.REJECTED,
      });
      const result = await service.reject(APPLICATION_ID, EMPLOYER_ID);
      expect(result.status).toBe(ApplicationStatus.REJECTED);
    });
  });

  describe('findById()', () => {
    it('returns null when not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await service.findById('non-existent')).toBeNull();
    });

    it('returns application with offer when found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      const result = await service.findById(APPLICATION_ID);
      expect(result?.id).toBe(APPLICATION_ID);
      expect(result?.job_offer.title).toBe('Plombier');
    });
  });

  describe('findByWorker()', () => {
    it('returns applications for worker', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const result = await service.findByWorker(WORKER_ID);
      expect(result).toHaveLength(1);
    });

    it('filters by status when provided', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      await service.findByWorker(WORKER_ID, {
        status: ApplicationStatus.ACCEPTED,
      });
      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: ApplicationStatus.ACCEPTED,
          }),
        }),
      );
    });

    it('uses custom limit', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      await service.findByWorker(WORKER_ID, { limit: 10 });
      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
    });
  });

  describe('findByJobOffer()', () => {
    it('returns applications for job offer', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const result = await service.findByJobOffer(JOB_OFFER_ID);
      expect(result).toHaveLength(1);
    });

    it('returns empty array when no applications', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      expect(await service.findByJobOffer(JOB_OFFER_ID)).toHaveLength(0);
    });
  });

  describe('wouldPenalizeCancellation()', () => {
    it('returns false when application not found (worker mismatch)', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await service.wouldPenalizeCancellation(APPLICATION_ID, WORKER_ID)).toBe(false);
    });

    it('returns false when worker_id does not match', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        worker_id: 'other-worker',
      });
      expect(await service.wouldPenalizeCancellation(APPLICATION_ID, WORKER_ID)).toBe(false);
    });

    it('returns false when status is not ACCEPTED or PENDING', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.CANCELLED,
      });
      expect(await service.wouldPenalizeCancellation(APPLICATION_ID, WORKER_ID)).toBe(false);
    });

    it('returns true when ACCEPTED and < 4h before', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: { ...mockJobOffer, scheduled_at: hoursFromNow(2) },
      });
      expect(await service.wouldPenalizeCancellation(APPLICATION_ID, WORKER_ID)).toBe(true);
    });

    it('returns false when > 4h before', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: { ...mockJobOffer, scheduled_at: hoursFromNow(5) },
      });
      expect(await service.wouldPenalizeCancellation(APPLICATION_ID, WORKER_ID)).toBe(false);
    });
  });

  describe('cancelAcceptedByEmployer()', () => {
    const acceptedApp = {
      ...mockApplication,
      status: ApplicationStatus.ACCEPTED,
    };

    beforeEach(() => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(acceptedApp);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      (prisma.application.update as jest.Mock).mockResolvedValue({
        ...acceptedApp,
        status: ApplicationStatus.CANCELLED,
      });
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        reliability_score: 90,
      });
      (prisma.profile.update as jest.Mock).mockResolvedValue({});
      jest.spyOn(service, 'findById').mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.CANCELLED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        } as any,
        worker: mockWorkerProfile as any,
      } as any);
    });

    it('cancels accepted application by employer', async () => {
      const result = await service.cancelAcceptedByEmployer(
        APPLICATION_ID,
        EMPLOYER_ID,
      );
      expect(result.status).toBe(ApplicationStatus.CANCELLED);
    });

    it('throws NotFoundException when application not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.cancelAcceptedByEmployer(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not the employer', async () => {
      await expect(
        service.cancelAcceptedByEmployer(APPLICATION_ID, 'other-employer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when application is not ACCEPTED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.PENDING,
      });
      await expect(
        service.cancelAcceptedByEmployer(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('markAsViewed()', () => {
    it('calls updateMany on application', async () => {
      (prisma.application.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      await service.markAsViewed(APPLICATION_ID);
      expect(prisma.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: APPLICATION_ID }),
        }),
      );
    });
  });

  describe('getUnpaidPenalties()', () => {
    it('returns unpaid penalties summary', async () => {
      (prisma.penalty.findMany as jest.Mock).mockResolvedValue([
        { id: 'p1', amount: 5000 },
        { id: 'p2', amount: 5000 },
      ]);
      const result = await service.getUnpaidPenalties(WORKER_ID);
      expect(result.count).toBe(2);
      expect(result.total).toBe(10000);
      expect(result.ids).toEqual(['p1', 'p2']);
    });

    it('returns zero when no unpaid penalties', async () => {
      (prisma.penalty.findMany as jest.Mock).mockResolvedValue([]);
      const result = await service.getUnpaidPenalties(WORKER_ID);
      expect(result.count).toBe(0);
      expect(result.total).toBe(0);
    });
  });

  describe('markPenaltiesPaid()', () => {
    it('returns zero when no unpaid penalties', async () => {
      (prisma.penalty.findMany as jest.Mock).mockResolvedValue([]);
      const result = await service.markPenaltiesPaid(WORKER_ID);
      expect(result.paidCount).toBe(0);
      expect(result.totalAmount).toBe(0);
    });

    it('marks penalties as paid', async () => {
      (prisma.penalty.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'p1', amount: 5000 }])
        .mockResolvedValueOnce([]); // for syncBillingStatus
      (prisma.penalty.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.profile.update as jest.Mock).mockResolvedValue({});
      const result = await service.markPenaltiesPaid(WORKER_ID);
      expect(result.paidCount).toBe(1);
      expect(result.totalAmount).toBe(5000);
    });
  });

  describe('findAcceptedInTimeWindow()', () => {
    it('returns accepted applications in time window', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([
        mockApplication,
      ]);
      const start = hoursFromNow(0);
      const end = hoursFromNow(24);
      const result = await service.findAcceptedInTimeWindow(start, end);
      expect(result).toHaveLength(1);
    });
  });

  describe('getApplicationsForAdmin()', () => {
    const adminApp = {
      ...mockApplication,
      worker: {
        id: WORKER_ID,
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'worker@test.com',
        phone: '+242111111',
        avatar_url: null,
      },
      job_offer: {
        id: JOB_OFFER_ID,
        title: 'Plombier',
        employer_id: EMPLOYER_ID,
        employer: {
          id: EMPLOYER_ID,
          first_name: 'John',
          last_name: 'Doe',
          email: 'employer@test.com',
          avatar_url: null,
        },
      },
    };

    it('returns paginated applications', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([adminApp]);
      (prisma.application.count as jest.Mock).mockResolvedValue(1);
      const result = await service.getApplicationsForAdmin({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].workerName).toBe('Jane Doe');
    });

    it('applies search filter', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      await service.getApplicationsForAdmin({ page: 1, limit: 10, q: 'Jane' });
      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('applies status filter', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      await service.getApplicationsForAdmin({
        page: 1,
        limit: 10,
        status: [ApplicationStatus.ACCEPTED],
      });
      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [ApplicationStatus.ACCEPTED] },
          }),
        }),
      );
    });

    it('applies penaltyApplied filter (true)', async () => {
      (prisma.application.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.application.count as jest.Mock).mockResolvedValue(0);
      await service.getApplicationsForAdmin({
        page: 1,
        limit: 10,
        penaltyApplied: ['true'],
      });
      expect(prisma.application.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ penalty_applied: true }),
        }),
      );
    });

    it('uses "—" when worker name is empty', async () => {
      const noNameApp = {
        ...adminApp,
        worker: { ...adminApp.worker, first_name: null, last_name: null },
      };
      (prisma.application.findMany as jest.Mock).mockResolvedValue([noNameApp]);
      (prisma.application.count as jest.Mock).mockResolvedValue(1);
      const result = await service.getApplicationsForAdmin({ page: 1, limit: 10 });
      expect(result.data[0].workerName).toBe('—');
    });
  });

  describe('getApplicationDetailForAdmin()', () => {
    const adminApp = {
      ...mockApplication,
      worker: {
        id: WORKER_ID,
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'worker@test.com',
        phone: '+242111111',
        avatar_url: null,
        reliability_score: 90,
      },
      job_offer: {
        id: JOB_OFFER_ID,
        title: 'Plombier',
        scheduled_at: hoursFromNow(5),
        amount: 15000,
        address: '123 Avenue',
        payment_flow: 'DAILY',
        status: 'ACTIVE',
        quantity: 1,
        employer_id: EMPLOYER_ID,
        employer: {
          id: EMPLOYER_ID,
          first_name: 'John',
          last_name: 'Doe',
          email: 'employer@test.com',
          phone: '+242000000',
          avatar_url: null,
        },
      },
      penalties: [
        {
          id: 'pen-1',
          amount: 5000,
          reason: 'Annulation tardive',
          applied_at: new Date(),
          paid_at: null,
          created_at: new Date(),
        },
      ],
    };

    it('returns full application detail', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(adminApp);
      const result = await service.getApplicationDetailForAdmin(APPLICATION_ID);
      expect(result.id).toBe(APPLICATION_ID);
      expect(result.workerName).toBe('Jane Doe');
      expect(result.penalties).toHaveLength(1);
      expect(result.workerReliabilityScore).toBe(90);
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getApplicationDetailForAdmin('non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('uses "—" for empty employer name', async () => {
      const noNameApp = {
        ...adminApp,
        job_offer: {
          ...adminApp.job_offer,
          employer: {
            ...adminApp.job_offer.employer,
            first_name: null,
            last_name: null,
          },
        },
      };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(noNameApp);
      const result = await service.getApplicationDetailForAdmin(APPLICATION_ID);
      expect(result.employerName).toBe('—');
    });

    it('handles null reliabilityScore', async () => {
      const noScoreApp = {
        ...adminApp,
        worker: { ...adminApp.worker, reliability_score: null },
      };
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(noScoreApp);
      const result = await service.getApplicationDetailForAdmin(APPLICATION_ID);
      expect(result.workerReliabilityScore).toBeNull();
    });
  });

  describe('cancel() error paths', () => {
    it('throws NotFoundException when application not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.cancel(APPLICATION_ID, WORKER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when worker is not the owner', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      await expect(
        service.cancel(APPLICATION_ID, 'other-worker'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when application cannot be cancelled', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.REJECTED,
      });
      await expect(service.cancel(APPLICATION_ID, WORKER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('accept() error paths', () => {
    it('throws NotFoundException when application not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.accept(APPLICATION_ID, EMPLOYER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when application is not PENDING/VIEWED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
      });
      await expect(service.accept(APPLICATION_ID, EMPLOYER_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('markJobCompleted() error paths', () => {
    it('throws NotFoundException when not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.markJobCompleted(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not employer', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
      });
      await expect(
        service.markJobCompleted(APPLICATION_ID, 'other-employer'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when application not ACCEPTED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      ); // PENDING
      await expect(
        service.markJobCompleted(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when job already COMPLETED', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          ...mockJobOffer,
          status: JobOfferStatus.COMPLETED,
        },
      });
      await expect(
        service.markJobCompleted(APPLICATION_ID, EMPLOYER_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
