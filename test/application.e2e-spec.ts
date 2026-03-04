/**
 * E2E integration tests for ApplicationService.
 * Tests the service layer with mocked PrismaService.
 */
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({})),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  ApplicationService,
  type ApplicationWithOffer,
} from '../src/modules/application/application.service';
import { PrismaService } from '../src/common/services/prisma/prisma.service';
import { ApplicationStatus, JobOfferStatus, PaymentFlow } from '@prisma/client';
import { LATE_CANCELLATION_PENALTY_FCFA } from '../src/modules/application/application.constants';

const JOB_OFFER_ID = 'offer-e2e-1';
const WORKER_ID = 'worker-e2e-1';
const EMPLOYER_ID = 'employer-e2e-1';
const APPLICATION_ID = 'app-e2e-1';

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

const mockJobOffer = {
  id: JOB_OFFER_ID,
  title: 'Plombier',
  description: 'Réparation urgente',
  scheduled_at: hoursFromNow(6),
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
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+242111111',
  email: 'worker@test.com',
  description: 'Worker',
  reliability_score: 100,
  verification_status: 'VERIFIED',
  avatar_url: null,
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
  worker: mockWorker,
};

const mockPrisma = {
  profile: { findUnique: jest.fn(), update: jest.fn() },
  jobOffer: { findUnique: jest.fn(), update: jest.fn() },
  penalty: { count: jest.fn(), create: jest.fn() },
  application: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  payment: { create: jest.fn() },
  $transaction: jest.fn(),
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

describe('ApplicationService (e2e integration)', () => {
  let service: ApplicationService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ApplicationService>(ApplicationService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.jobOffer.findUnique.mockResolvedValue(mockJobOffer);
    mockPrisma.profile.findUnique.mockResolvedValue(mockWorker);
    mockPrisma.penalty.count.mockResolvedValue(0);
    mockPrisma.application.findUnique.mockResolvedValue(null);
    mockPrisma.application.create.mockResolvedValue({
      ...mockApplication,
      job_offer: mockJobOffer,
    });
    mockPrisma.$transaction.mockResolvedValue([]);
  });

  describe('POST /applications (worker applies)', () => {
    it('valid worker creates application → 201 (PENDING)', async () => {
      const result = await service.create(JOB_OFFER_ID, WORKER_ID);
      expect(result.status).toBe(ApplicationStatus.PENDING);
      expect(result.worker_id).toBe(WORKER_ID);
    });

    it('worker with unpaid penalty → 403 ForbiddenException', async () => {
      mockPrisma.penalty.count.mockResolvedValue(1);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('worker already applied → 409 ConflictException', async () => {
      mockPrisma.application.findUnique.mockResolvedValue(mockApplication);
      await expect(service.create(JOB_OFFER_ID, WORKER_ID)).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('POST /applications/:id/accept (employer accepts)', () => {
    beforeEach(() => {
      mockPrisma.application.findUnique.mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.PENDING,
      });
      const acceptedApplication: ApplicationWithOffer = {
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        },
        worker: mockWorker,
      };
      jest.spyOn(service, 'findById').mockResolvedValue(acceptedApplication);
    });

    it('employer accepts → 200', async () => {
      const result = await service.accept(APPLICATION_ID, EMPLOYER_ID);
      expect(result.status).toBe(ApplicationStatus.ACCEPTED);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('non-employer tries to accept → 403 ForbiddenException', async () => {
      await expect(service.accept(APPLICATION_ID, 'other-id')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('POST /applications/:id/cancel (worker cancels)', () => {
    beforeEach(() => {
      const cancelledApplication: ApplicationWithOffer = {
        ...mockApplication,
        status: ApplicationStatus.CANCELLED,
        job_offer: {
          ...mockJobOffer,
          description: 'desc',
          payment_flow: 'DAILY',
          note: null,
        },
        worker: mockWorker,
      };
      jest.spyOn(service, 'findById').mockResolvedValue(cancelledApplication);
      mockPrisma.application.update.mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.CANCELLED,
        cancelled_at: new Date(),
        job_offer: mockJobOffer,
        worker: mockWorker,
      });
      mockPrisma.jobOffer.update.mockResolvedValue(mockJobOffer);
    });

    it('cancel > 4h before → 200, no penalty', async () => {
      mockPrisma.application.findUnique.mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: { ...mockJobOffer, scheduled_at: hoursFromNow(6) },
      });
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(false);
      expect(result.penaltyAmount).toBeNull();
      expect(mockPrisma.penalty.create).not.toHaveBeenCalled();
    });

    it('cancel < 4h before (ACCEPTED) → 200, penalty 5000 FCFA applied', async () => {
      mockPrisma.application.findUnique.mockResolvedValue({
        ...mockApplication,
        status: ApplicationStatus.ACCEPTED,
        job_offer: { ...mockJobOffer, scheduled_at: hoursFromNow(2) },
      });
      mockPrisma.profile.findUnique.mockResolvedValue({
        id: WORKER_ID,
        reliability_score: 100,
      });
      mockPrisma.penalty.create.mockResolvedValue({});
      mockPrisma.profile.update.mockResolvedValue({});
      const result = await service.cancel(APPLICATION_ID, WORKER_ID);
      expect(result.penaltyApplied).toBe(true);
      expect(result.penaltyAmount).toBe(LATE_CANCELLATION_PENALTY_FCFA);
      expect(mockPrisma.penalty.create).toHaveBeenCalled();
    });
  });
});
