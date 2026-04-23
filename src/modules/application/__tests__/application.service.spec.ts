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
import { ApplicationStatus, JobOfferStatus, PaymentFlow } from '@prisma/client';
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

  beforeEach(async () => {
    const mockPrismaService = {
      jobOffer: { findUnique: jest.fn(), update: jest.fn() },
      profile: { findUnique: jest.fn(), update: jest.fn() },
      penalty: { count: jest.fn(), create: jest.fn() },
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
          // Interactive transaction: call with mockPrismaService as tx
          return arg(mockPrismaService);
        }
        // Array transaction: resolve with empty results
        return Promise.resolve([]);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: BotNotificationService,
          useValue: {
            sendNewApplicationToEmployer: jest.fn(),
            sendApplicationAcceptedToWorker: jest.fn(),
            sendApplicationRejectedToWorker: jest.fn(),
            sendCancellationToEmployer: jest.fn(),
            sendJobCompletedToWorker: jest.fn(),
            sendJobCancelledByEmployerToWorker: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ContactUnlockService, useValue: { initiateUnlock: jest.fn().mockResolvedValue(undefined) } },
        { provide: ContractService, useValue: { create: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<ApplicationService>(ApplicationService);
    prisma = module.get(PrismaService);
  });

  describe('create()', () => {
    beforeEach(() => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockJobOffer);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockWorker);
      (prisma.penalty.count as jest.Mock).mockResolvedValue(0);
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.application.create as jest.Mock).mockResolvedValue({
        ...mockApplication,
        job_offer: mockJobOffer,
      });
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

    it('throws ConflictException when worker already applied', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(
        mockApplication,
      );
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ConflictException,
      );
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
      expect(prisma.penalty.create as jest.Mock).toHaveBeenCalled();
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
      expect(prisma.penalty.create as jest.Mock).not.toHaveBeenCalled();
    });

    it('reverts offer to ACTIVE when cancelling accepted application', async () => {
      await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(prisma.jobOffer.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: JobOfferStatus.ACTIVE },
        }),
      );
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

    it('throws ForbiddenException when non-employer tries to accept', async () => {
      await expect(
        service.accept(APPLICATION_ID, 'other-employer-id'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('markJobCompleted()', () => {
    const setupMock = (status: ApplicationStatus) => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        ...mockApplication,
        status,
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue([]);
      jest.spyOn(service, 'findById').mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.END,
        job_offer: {
          ...mockJobOffer,
          status: JobOfferStatus.COMPLETED,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        } as any,
        worker: mockApplication.worker as any,
      } as any);
    };

    it('marks offer as COMPLETED when application is ACCEPTED', async () => {
      setupMock(ApplicationStatus.ACCEPTED);
      const result = await service.markJobCompleted(
        APPLICATION_ID,
        EMPLOYER_ID,
      );
      expect(prisma.$transaction as jest.Mock).toHaveBeenCalled();
      expect(result.job_offer.status).toBe(JobOfferStatus.COMPLETED);
    });

    it('marks offer as COMPLETED when application is STARTED', async () => {
      setupMock(ApplicationStatus.STARTED);
      const result = await service.markJobCompleted(
        APPLICATION_ID,
        EMPLOYER_ID,
      );
      expect(prisma.$transaction as jest.Mock).toHaveBeenCalled();
      expect(result.job_offer.status).toBe(JobOfferStatus.COMPLETED);
    });

    it('sets applications to END status inside transaction', async () => {
      setupMock(ApplicationStatus.ACCEPTED);

      let capturedTx: any;
      (prisma.$transaction as jest.Mock).mockImplementationOnce((fn: any) => {
        capturedTx = {
          jobOffer: { update: jest.fn().mockResolvedValue({}) },
          assignment: { updateMany: jest.fn().mockResolvedValue({}) },
          payment: { create: jest.fn().mockResolvedValue({}) },
          application: { updateMany: jest.fn().mockResolvedValue({}) },
          profile: {
            findUnique: jest.fn().mockResolvedValue({ reliability_score: 100 }),
            update: jest.fn().mockResolvedValue({}),
          },
        };
        return fn(capturedTx);
      });

      await service.markJobCompleted(APPLICATION_ID, EMPLOYER_ID);

      expect(capturedTx.application.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            job_offer_id: JOB_OFFER_ID,
            status: {
              in: [ApplicationStatus.ACCEPTED, ApplicationStatus.STARTED],
            },
          }),
          data: { status: ApplicationStatus.END },
        }),
      );
    });
  });
});
