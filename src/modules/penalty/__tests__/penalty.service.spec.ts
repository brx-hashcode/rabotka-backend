import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PenaltyService } from '../penalty.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WalletService } from '../../wallet/wallet.service';

const PENALTY_ID = 'penalty-uuid-1';
const WORKER_ID = 'worker-uuid-1';
const APPLICATION_ID = 'app-uuid-1';
const JOB_OFFER_ID = 'offer-uuid-1';

const mockPenaltyFull = {
  id: PENALTY_ID,
  worker_id: WORKER_ID,
  application_id: APPLICATION_ID,
  amount: 5000,
  reason: 'Late cancellation',
  applied_at: new Date('2026-01-01T10:00:00Z'),
  paid_at: null,
  created_at: new Date('2026-01-01T10:00:00Z'),
  worker: {
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

  beforeEach(async () => {
    const mockPrismaService = {
      penalty: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PenaltyService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: WalletService,
          useValue: { getProfileWalletBalance: jest.fn().mockResolvedValue(0) },
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
      expect(result.workerName).toBe('Jane Doe');
      expect(result.workerEmail).toBe('worker@example.com');
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
        worker: {
          ...mockPenaltyFull.worker,
          first_name: null,
          last_name: null,
        },
      });

      const result = await service.getPenaltyDetailForAdmin(PENALTY_ID);
      expect(result.workerName).toBe('—');
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
      worker_id: WORKER_ID,
      application_id: APPLICATION_ID,
      amount: 5000,
      reason: 'Late cancellation',
      applied_at: new Date('2026-01-01T10:00:00Z'),
      paid_at: null,
      created_at: new Date('2026-01-01T10:00:00Z'),
      worker: {
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
});
