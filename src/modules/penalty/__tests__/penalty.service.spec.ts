import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PenaltyService } from '../penalty.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WalletService } from '../../wallet/wallet.service';

const PENALTY_ID = 'penalty-uuid-1';
const WORKER_ID = 'worker-uuid-1';
const APPLICATION_ID = 'app-uuid-1';
const JOB_OFFER_ID = 'offer-uuid-1';

const mockPenaltyFull = {
  id: PENALTY_ID,
  profile_id: WORKER_ID,
  application_id: APPLICATION_ID,
  amount: 5000,
  reason: 'Late cancellation',
  applied_at: new Date('2026-01-01T10:00:00Z'),
  paid_at: null,
  created_at: new Date('2026-01-01T10:00:00Z'),
  profile: {
    id: WORKER_ID,
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'worker@example.com',
    phone: '+242000001',
    avatar_url: null,
  },
  application: {
    id: APPLICATION_ID,
    status: 'CANCELLED',
    job_offer: {
      id: JOB_OFFER_ID,
      title: 'Plombier',
      scheduled_at: new Date('2026-01-02T08:00:00Z'),
      amount: 15000,
      address: '10 Rue de la Paix',
      payment_flow: 'DAILY',
      status: 'CANCELLED',
    },
  },
};

describe('PenaltyService', () => {
  let service: PenaltyService;
  let prisma: jest.Mocked<PrismaService>;
  let walletService: any;

  beforeEach(async () => {
    const mockPrismaService = {
      penalty: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      application: {
        findUnique: jest.fn(),
      },
      profile: {
        update: jest.fn(),
      },
      log: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltyService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: WalletService,
          useValue: {
            getProfileWalletBalance: jest.fn().mockResolvedValue(0),
            recordPenaltyPayment: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<PenaltyService>(PenaltyService);
    prisma = module.get(PrismaService);
  });

  describe('getPenaltyDetailForAdmin()', () => {
    it('returns formatted penalty detail', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(
        mockPenaltyFull,
      );

      const result = await service.getPenaltyDetailForAdmin(PENALTY_ID);

      expect(result.id).toBe(PENALTY_ID);
      expect(result.profileName).toBe('Jane Doe');
      expect(result.profileEmail).toBe('worker@example.com');
      expect(result.amount).toBe(5000);
      expect(result.jobTitle).toBe('Plombier');
      expect(result.jobOfferId).toBe(JOB_OFFER_ID);
      expect(result.applicationStatus).toBe('CANCELLED');
      expect(result.paidAt).toBeNull();
    });

    it('throws NotFoundException when penalty not found', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getPenaltyDetailForAdmin(PENALTY_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('formats workerName as "—" when no name', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        ...mockPenaltyFull,
        profile: {
          ...mockPenaltyFull.profile,
          first_name: null,
          last_name: null,
        },
      });

      const result = await service.getPenaltyDetailForAdmin(PENALTY_ID);
      expect(result.profileName).toBe('—');
    });

    it('includes paidAt when penalty is paid', async () => {
      const paidAt = new Date('2026-01-05T12:00:00Z');
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        ...mockPenaltyFull,
        paid_at: paidAt,
      });

      const result = await service.getPenaltyDetailForAdmin(PENALTY_ID);
      expect(result.paidAt).toBe(paidAt.toISOString());
    });
  });

  describe('getPenaltiesForAdmin()', () => {
    const mockPenaltyListItem = {
      id: PENALTY_ID,
      profile_id: WORKER_ID,
      application_id: APPLICATION_ID,
      amount: 5000,
      reason: 'Late cancellation',
      applied_at: new Date('2026-01-01T10:00:00Z'),
      paid_at: null,
      created_at: new Date('2026-01-01T10:00:00Z'),
      profile: {
        id: WORKER_ID,
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'worker@example.com',
        phone: '+242000001',
        avatar_url: null,
      },
      application: {
        id: APPLICATION_ID,
        job_offer: { title: 'Plombier' },
      },
    };

    beforeEach(() => {
      (prisma.penalty.findMany as jest.Mock).mockResolvedValue([
        mockPenaltyListItem,
      ]);
      (prisma.penalty.count as jest.Mock).mockResolvedValue(1);
    });

    it('returns paginated list', async () => {
      const result = await service.getPenaltiesForAdmin({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.data[0].jobTitle).toBe('Plombier');
    });

    it('applies search filter when q is provided', async () => {
      await service.getPenaltiesForAdmin({ page: 1, limit: 10, q: 'jane' });

      expect(prisma.penalty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('filters by paymentStatus=paid', async () => {
      await service.getPenaltiesForAdmin({
        page: 1,
        limit: 10,
        paymentStatus: ['paid'],
      });

      expect(prisma.penalty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ paid_at: { not: null } }),
        }),
      );
    });

    it('filters by paymentStatus=unpaid', async () => {
      await service.getPenaltiesForAdmin({
        page: 1,
        limit: 10,
        paymentStatus: ['unpaid'],
      });

      expect(prisma.penalty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ paid_at: null }),
        }),
      );
    });
  });

  describe('createPenaltyByAdmin()', () => {
    const baseParams = {
      profileId: WORKER_ID,
      amount: 5000,
      reason: 'Manual penalty',
      adminUserId: 'admin-1',
    };

    it('creates penalty without applicationId', async () => {
      (prisma.penalty.create as jest.Mock).mockResolvedValue({
        id: PENALTY_ID,
        profile_id: WORKER_ID,
      });
      (prisma.profile.update as jest.Mock).mockResolvedValue({});
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(
        mockPenaltyFull,
      );

      const result = await service.createPenaltyByAdmin(baseParams);
      expect(result.id).toBe(PENALTY_ID);
    });

    it('creates penalty with valid applicationId', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        id: APPLICATION_ID,
        worker_id: WORKER_ID,
        job_offer: { employer_id: 'employer-1' },
      });
      (prisma.penalty.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.penalty.create as jest.Mock).mockResolvedValue({
        id: PENALTY_ID,
        profile_id: WORKER_ID,
      });
      (prisma.profile.update as jest.Mock).mockResolvedValue({});
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(
        mockPenaltyFull,
      );

      const result = await service.createPenaltyByAdmin({
        ...baseParams,
        applicationId: APPLICATION_ID,
      });
      expect(result.id).toBe(PENALTY_ID);
    });

    it('throws NotFoundException when application not found', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.createPenaltyByAdmin({ ...baseParams, applicationId: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when profile not in application', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        id: APPLICATION_ID,
        worker_id: 'other-worker',
        job_offer: { employer_id: 'other-employer' },
      });
      await expect(
        service.createPenaltyByAdmin({
          ...baseParams,
          applicationId: APPLICATION_ID,
        }),
      ).rejects.toThrow();
    });

    it('throws ConflictException when penalty already exists for application', async () => {
      (prisma.application.findUnique as jest.Mock).mockResolvedValue({
        id: APPLICATION_ID,
        worker_id: WORKER_ID,
        job_offer: { employer_id: 'employer-1' },
      });
      (prisma.penalty.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-penalty',
      });
      await expect(
        service.createPenaltyByAdmin({
          ...baseParams,
          applicationId: APPLICATION_ID,
        }),
      ).rejects.toThrow();
    });
  });

  describe('confirmPenaltyPaymentByAdmin()', () => {
    it('confirms payment successfully', async () => {
      (prisma.penalty.findUnique as jest.Mock)
        .mockResolvedValueOnce({
          id: PENALTY_ID,
          paid_at: null,
          profile_id: WORKER_ID,
        })
        .mockResolvedValue(mockPenaltyFull);
      (prisma.penalty.count as jest.Mock).mockResolvedValue(0);
      (prisma.profile.update as jest.Mock).mockResolvedValue({});

      const result = await service.confirmPenaltyPaymentByAdmin(
        PENALTY_ID,
        'admin-1',
      );
      expect(result.id).toBe(PENALTY_ID);
    });

    it('throws NotFoundException when penalty not found', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.confirmPenaltyPaymentByAdmin('x', 'admin-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when already paid', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        id: PENALTY_ID,
        paid_at: new Date(),
        profile_id: WORKER_ID,
      });
      await expect(
        service.confirmPenaltyPaymentByAdmin(PENALTY_ID, 'admin-1'),
      ).rejects.toThrow();
    });
  });

  describe('deletePenalty()', () => {
    it('archives penalty successfully (soft delete)', async () => {
      (prisma.penalty.findFirst as jest.Mock).mockResolvedValue({
        id: PENALTY_ID,
        profile_id: WORKER_ID,
        paid_at: null,
      });
      (prisma.penalty.update as jest.Mock).mockResolvedValue({});
      (prisma.penalty.count as jest.Mock).mockResolvedValue(0);
      (prisma.profile.update as jest.Mock).mockResolvedValue({});

      const result = await service.deletePenalty(PENALTY_ID);
      expect(result.success).toBe(true);
      expect(prisma.penalty.update as jest.Mock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PENALTY_ID },
          data: { deleted_at: expect.any(Date) },
        }),
      );
    });

    it('throws BadRequestException when trying to delete a paid penalty', async () => {
      (prisma.penalty.findFirst as jest.Mock).mockResolvedValue({
        id: PENALTY_ID,
        profile_id: WORKER_ID,
        paid_at: new Date(),
      });
      await expect(service.deletePenalty(PENALTY_ID)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.penalty.update as jest.Mock).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when penalty not found', async () => {
      (prisma.penalty.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.deletePenalty('x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
