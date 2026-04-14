import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WalletService } from '../wallet.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletOwnerType, WalletTransactionType, PaymentStatus, PaymentType, PaymentMethod } from '@prisma/client';
import { generatePaymentReference } from '../../../common/utils/payment-reference';

jest.mock('../../../common/utils/payment-reference', () => ({
  generatePaymentReference: jest.fn(() => 'RBK-2025-20250304-abc12345'),
}));

const SYSTEM_WALLET_ID = 'wallet-system-1';
const PENALTY_ID = 'penalty-1';
const PROFILE_ID = 'profile-worker-1';

const mockSystemWallet = {
  id: SYSTEM_WALLET_ID,
  owner_type: WalletOwnerType.SYSTEM,
  user_id: null,
  profile_id: null,
  balance: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

const mockPenalty = {
  id: PENALTY_ID,
  worker_id: PROFILE_ID,
  application_id: 'app-1',
  amount: 5000,
  reason: 'Late cancellation',
  applied_at: new Date(),
  paid_at: null,
};

describe('WalletService', () => {
  let service: WalletService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      wallet: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      walletTransaction: { create: jest.fn(), aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
      penalty: { findUnique: jest.fn(), update: jest.fn() },
      payment: {
        create: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => (typeof cb === 'function' ? cb(mockPrismaService) : Promise.resolve())),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue('') } },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    prisma = module.get(PrismaService);
  });

  describe('getOrCreateSystemWallet()', () => {
    it('returns existing system wallet when found', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(mockSystemWallet);

      const result = await service.getOrCreateSystemWallet();

      expect(result.id).toBe(SYSTEM_WALLET_ID);
      expect(result.balance).toBe(0);
      expect(prisma.wallet.create).not.toHaveBeenCalled();
    });

    it('creates system wallet when none exists', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.wallet.create as jest.Mock).mockResolvedValue(mockSystemWallet);

      const result = await service.getOrCreateSystemWallet();

      expect(result.id).toBe(SYSTEM_WALLET_ID);
      expect(prisma.wallet.create).toHaveBeenCalledWith({
        data: {
          owner_type: WalletOwnerType.SYSTEM,
          balance: 0,
        },
      });
    });
  });

  describe('recordPenaltyPayment()', () => {
    const dto: { transactionId?: string; paymentMethod: PaymentMethod } = {
      paymentMethod: PaymentMethod.MOBILE_MONEY,
    };

    let transactionTx: {
      payment: { create: jest.Mock };
      walletTransaction: { create: jest.Mock };
      wallet: { update: jest.Mock };
      penalty: { update: jest.Mock };
    };

    beforeEach(() => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(mockPenalty);
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(mockSystemWallet);
      transactionTx = {
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
        penalty: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb(transactionTx),
      );
    });

    it('throws NotFoundException when penalty does not exist', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.recordPenaltyPayment(PENALTY_ID, PROFILE_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when penalty belongs to another profile', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        ...mockPenalty,
        worker_id: 'other-profile-id',
      });

      await expect(
        service.recordPenaltyPayment(PENALTY_ID, PROFILE_ID, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when penalty already paid', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        ...mockPenalty,
        paid_at: new Date(),
      });

      await expect(
        service.recordPenaltyPayment(PENALTY_ID, PROFILE_ID, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('runs transaction: creates payment with RBK reference, wallet transaction, updates wallet and penalty', async () => {
      const result = await service.recordPenaltyPayment(PENALTY_ID, PROFILE_ID, dto);

      const expectedReference = (generatePaymentReference as jest.Mock)();
      expect(result.reference).toBe(expectedReference);
      expect(transactionTx.payment.create).toHaveBeenCalledWith({
        data: {
          type: PaymentType.PENALTY,
          profile_id: PROFILE_ID,
          amount: mockPenalty.amount,
          payment_method: dto.paymentMethod,
          transaction_id: expectedReference,
          status: PaymentStatus.COMPLETED,
          paid_at: expect.any(Date),
          description: `Penalty payment for penalty ${PENALTY_ID}`,
        },
      });
      expect(transactionTx.walletTransaction.create).toHaveBeenCalledWith({
        data: {
          wallet_id: SYSTEM_WALLET_ID,
          type: WalletTransactionType.CREDIT_PENALTY,
          amount: mockPenalty.amount,
          reference_type: 'penalty',
          reference_id: PENALTY_ID,
        },
      });
      expect(transactionTx.wallet.update).toHaveBeenCalledWith({
        where: { id: SYSTEM_WALLET_ID },
        data: { balance: { increment: mockPenalty.amount } },
      });
      expect(transactionTx.penalty.update).toHaveBeenCalledWith({
        where: { id: PENALTY_ID },
        data: { paid_at: expect.any(Date) },
      });
    });
  });

  describe('getSystemRevenue()', () => {
    it('returns system wallet balance as totalRevenue', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        ...mockSystemWallet,
        balance: 10000,
      });
      (prisma.payment.aggregate as jest.Mock).mockResolvedValue({
        _sum: { amount: { toFixed: () => '10000' } },
        _count: 5,
      });
      (prisma.payment.count as jest.Mock).mockResolvedValue(0);
      (prisma.payment.findMany as jest.Mock).mockResolvedValue([
        { type: PaymentType.JOB_POSTING, amount: 5000 },
        { type: PaymentType.REGISTRATION, amount: 3000 },
        { type: PaymentType.PENALTY, amount: 2000 },
      ]);

      const result = await service.getSystemRevenue();

      expect(result.totalRevenue).toBeDefined();
      expect(result.balance).toBeDefined();
    });
  });
});
