import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { WalletService } from '../wallet.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { InvoiceService } from '../../invoice/invoice.service';
import {
  WalletOwnerType,
  WalletTransactionType,
  PaymentStatus,
  PaymentType,
  PaymentMethod,
} from '@prisma/client';
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
  profile_id: PROFILE_ID,
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
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'wallet-profile-1', balance: 200 }),
      },
      walletTransaction: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      profile: { findUnique: jest.fn() },
      penalty: { findUnique: jest.fn(), update: jest.fn() },
      payment: {
        create: jest.fn(),
        aggregate: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
      },
      paymentRequest: { create: jest.fn().mockResolvedValue({ id: 'pr-1' }) },
      $transaction: jest.fn((cb) =>
        typeof cb === 'function' ? cb(mockPrismaService) : Promise.resolve(),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue('') },
        },
        {
          provide: InvoiceService,
          useValue: {
            createInvoice: jest.fn().mockResolvedValue({ id: 'inv-1' }),
            create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
          },
        },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    prisma = module.get(PrismaService);
  });

  describe('getOrCreateSystemWallet()', () => {
    it('returns existing system wallet when found', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(
        mockSystemWallet,
      );

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
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(
        mockSystemWallet,
      );
      transactionTx = {
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
        penalty: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (tx: unknown) => Promise<unknown>) => cb(transactionTx),
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
        profile_id: 'other-profile-id',
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
      const result = await service.recordPenaltyPayment(
        PENALTY_ID,
        PROFILE_ID,
        dto,
      );

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

  describe('getOrCreateProfileWallet()', () => {
    it('upserts and returns profile wallet', async () => {
      const mockProfileWallet = { id: 'wallet-profile-1', balance: 200 };
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue(mockProfileWallet);

      const result = await service.getOrCreateProfileWallet('profile-1');
      expect(result.id).toBe('wallet-profile-1');
      expect(result.balance).toBe(200);
    });
  });

  describe('getProfileWalletBalance()', () => {
    it('returns balance for profile', async () => {
      const mockProfileWallet = { id: 'wallet-profile-1', balance: 500 };
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue(mockProfileWallet);
      const balance = await service.getProfileWalletBalance('profile-1');
      expect(balance).toBe(500);
    });
  });

  describe('getProfileWalletForAdmin()', () => {
    it('returns wallet with empty transactions list', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 300 });
      (prisma.walletTransaction as any).findMany = jest
        .fn()
        .mockResolvedValue([]);

      const result = await service.getProfileWalletForAdmin('profile-1');
      expect(result.balance).toBe(300);
      expect(result.transactions).toEqual([]);
    });

    it('maps transaction fields', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 300 });
      (prisma.walletTransaction as any).findMany = jest.fn().mockResolvedValue([
        {
          id: 'tx-1',
          wallet_id: 'w1',
          type: 'CREDIT_PENALTY',
          amount: 1000,
          reference_type: 'penalty',
          reference_id: 'p1',
          created_at: new Date('2026-01-01'),
        },
      ]);

      const result = await service.getProfileWalletForAdmin('profile-1');
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        id: 'tx-1',
        amount: 1000,
        referenceType: 'penalty',
      });
    });
  });

  describe('creditProfileWallet()', () => {
    it('credits wallet via transaction', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 0 });
      const txMock = {
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await service.creditProfileWallet(
        'profile-1',
        200,
        WalletTransactionType.WELCOME_CREDIT,
      );
      expect(txMock.walletTransaction.create).toHaveBeenCalled();
      expect(txMock.wallet.update).toHaveBeenCalled();
    });
  });

  describe('debitProfileWallet()', () => {
    it('debits wallet when balance is sufficient', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 500 });
      const txMock = {
        wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await service.debitProfileWallet(
        'profile-1',
        100,
        WalletTransactionType.PENALTY_DEBIT,
      );
      expect(txMock.wallet.updateMany).toHaveBeenCalled();
    });

    it('throws BadRequestException when balance insufficient', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 50 });
      const txMock = {
        wallet: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        walletTransaction: { create: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await expect(
        service.debitProfileWallet(
          'profile-1',
          500,
          WalletTransactionType.PENALTY_DEBIT,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('grantWelcomeCredit()', () => {
    beforeEach(() => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w1', balance: 0 });
      const txMock = {
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
        profile: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation((cb: any) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve();
      });
    });

    it('grants WORKER credit', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        whatsapp_activation_bonus_granted: false,
      });
      // grantWelcomeCredit calls systemConfig.getWelcomeCredits — the mock has get() not getWelcomeCredits()
      // so calling service will fail unless we stub it:
      const sysConfig = (service as any).systemConfig;
      sysConfig.getWelcomeCredits = jest
        .fn()
        .mockResolvedValue({ workerCreditFcfa: 500, employerCreditFcfa: 1000 });
      const amount = await service.grantWelcomeCredit(
        'profile-1',
        'WORKER' as any,
      );
      expect(amount).toBe(500);
    });

    it('returns 0 if bonus already granted', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        whatsapp_activation_bonus_granted: true,
      });
      const amount = await service.grantWelcomeCredit(
        'profile-1',
        'WORKER' as any,
      );
      expect(amount).toBe(0);
    });

    it('throws NotFoundException if profile not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.grantWelcomeCredit('missing', 'WORKER' as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('payPenaltyFromWallet()', () => {
    it('throws NotFoundException when penalty not found', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.payPenaltyFromWallet('pen-1', 'p-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when penalty belongs to another profile', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        id: 'pen-1',
        profile_id: 'other',
        amount: 500,
      });
      await expect(
        service.payPenaltyFromWallet('pen-1', 'p-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws when penalty already paid (count=0)', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        id: 'pen-1',
        profile_id: 'p-1',
        amount: 500,
      });
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w-profile', balance: 1000 });
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-system',
        balance: 0,
      });
      const txMock = {
        penalty: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn(),
        },
        walletTransaction: { create: jest.fn() },
        payment: { create: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );
      await expect(
        service.payPenaltyFromWallet('pen-1', 'p-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when wallet balance insufficient (count=0)', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        id: 'pen-1',
        profile_id: 'p-1',
        amount: 500,
      });
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w-profile', balance: 0 });
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-system',
        balance: 0,
      });
      const txMock = {
        penalty: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          update: jest.fn(),
        },
        walletTransaction: { create: jest.fn() },
        payment: { create: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );
      await expect(
        service.payPenaltyFromWallet('pen-1', 'p-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('succeeds and returns reference', async () => {
      (prisma.penalty.findUnique as jest.Mock).mockResolvedValue({
        id: 'pen-1',
        profile_id: 'p-1',
        amount: 500,
      });
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w-profile', balance: 1000 });
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-system',
        balance: 0,
      });
      const txMock = {
        penalty: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        payment: { create: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );
      (prisma.paymentRequest.create as jest.Mock).mockResolvedValue({
        id: 'pr-1',
      });
      const result = await service.payPenaltyFromWallet('pen-1', 'p-1');
      expect(result.reference).toBeDefined();
    });
  });

  describe('recordRegistrationPayment()', () => {
    it('creates payment, wallet tx, and increments system wallet', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-sys',
        balance: 0,
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue(undefined);
      await service.recordRegistrationPayment('profile-1', 2000);
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('recordJobPostingPayment()', () => {
    it('creates payment for job posting', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-sys',
        balance: 0,
      });
      (prisma.$transaction as jest.Mock).mockResolvedValue(undefined);
      await service.recordJobPostingPayment('jo-1', 'emp-1', 5000);
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('getMonthlyRevenueForCalendarYear()', () => {
    it('queries and maps monthly revenue', async () => {
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue([
        { month: new Date('2026-01-01'), revenue: BigInt(10000) },
        { month: new Date('2026-02-01'), revenue: BigInt(5000) },
      ]);
      const result = await service.getMonthlyRevenueForCalendarYear(2026);
      expect(result).toHaveLength(2);
      expect(result[0].revenue).toBe(10000);
      expect(result[0].month).toBe('2026-01');
    });
  });

  describe('getMonthlyRevenueRollingMonths()', () => {
    it('queries and maps rolling months', async () => {
      (prisma as any).$queryRaw = jest
        .fn()
        .mockResolvedValue([
          { month: new Date('2026-01-01'), revenue: BigInt(3000) },
        ]);
      const result = await service.getMonthlyRevenueRollingMonths(6);
      expect(result).toHaveLength(1);
      expect(result[0].revenue).toBe(3000);
    });
  });

  describe('listTransactionsForAdmin()', () => {
    beforeEach(() => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-sys',
        balance: 0,
      });
      (prisma.walletTransaction as any).findMany = jest.fn().mockResolvedValue([
        {
          id: 'tx-1',
          wallet_id: 'w-sys',
          type: 'CREDIT_PENALTY',
          amount: 500,
          reference_type: 'penalty',
          reference_id: 'pen-1',
          created_at: new Date('2026-01-01'),
        },
      ]);
      (prisma.walletTransaction as any).count = jest.fn().mockResolvedValue(1);
    });

    it('returns paginated transactions', async () => {
      const result = await service.listTransactionsForAdmin({
        page: 1,
        limit: 10,
      });
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('applies query filter', async () => {
      (prisma.walletTransaction as any).findMany = jest
        .fn()
        .mockResolvedValue([]);
      (prisma.walletTransaction as any).count = jest.fn().mockResolvedValue(0);
      const result = await service.listTransactionsForAdmin({
        page: 1,
        limit: 10,
        q: 'penalty',
      });
      expect(result.data).toHaveLength(0);
    });

    it('applies type filter', async () => {
      const result = await service.listTransactionsForAdmin({
        page: 1,
        limit: 10,
        type: ['CREDIT_PENALTY'],
      });
      expect(prisma.walletTransaction.findMany).toHaveBeenCalled();
    });

    it('applies date range filter', async () => {
      const result = await service.listTransactionsForAdmin({
        page: 1,
        limit: 10,
        created_from: '2026-01-01',
        created_to: '2026-12-31',
      });
      expect(result.total).toBe(1);
    });
  });

  describe('listPaymentsForAdmin()', () => {
    beforeEach(() => {
      (prisma.payment.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'pay-1',
          profile_id: 'p-1',
          type: 'PENALTY',
          amount: 5000,
          payment_method: 'MOBILE_MONEY',
          transaction_id: 'tx-1',
          status: 'COMPLETED',
          paid_at: new Date(),
          description: 'Test',
          created_at: new Date(),
          profile: {
            first_name: 'Alice',
            last_name: 'Dupont',
            email: 'alice@test.com',
          },
        },
      ]);
      (prisma.payment.count as jest.Mock).mockResolvedValue(1);
    });

    it('returns paginated payments', async () => {
      const result = await service.listPaymentsForAdmin({ page: 1, limit: 10 });
      expect(result.total).toBe(1);
      expect(result.data[0].type).toBe('PENALTY');
    });

    it('applies query filter', async () => {
      (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.payment.count as jest.Mock).mockResolvedValue(0);
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);
      const result = await service.listPaymentsForAdmin({
        page: 1,
        limit: 10,
        q: 'alice',
      });
      expect(result.data).toHaveLength(0);
    });

    it('applies type and status filters', async () => {
      const result = await service.listPaymentsForAdmin({
        page: 1,
        limit: 10,
        type: ['PENALTY'],
        status: ['COMPLETED'],
      });
      expect(result.total).toBe(1);
    });

    it('applies date range filter', async () => {
      const result = await service.listPaymentsForAdmin({
        page: 1,
        limit: 10,
        created_from: '2026-01-01',
        created_to: '2026-12-31',
      });
      expect(result.total).toBe(1);
    });
  });

  describe('debitProfileAndCreditSystem()', () => {
    it('transfers from profile to system', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w-profile', balance: 1000 });
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-system',
        balance: 0,
      });
      const txMock = {
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await service.debitProfileAndCreditSystem(
        'profile-1',
        100,
        WalletTransactionType.PENALTY_DEBIT,
        WalletTransactionType.CREDIT_PENALTY,
        'penalty',
        'pen-1',
      );
      expect(txMock.wallet.updateMany).toHaveBeenCalled();
    });

    it('throws BadRequestException when profile balance insufficient', async () => {
      (prisma.wallet as any).upsert = jest
        .fn()
        .mockResolvedValue({ id: 'w-profile', balance: 10 });
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        id: 'w-system',
        balance: 0,
      });
      const txMock = {
        wallet: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        walletTransaction: { create: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await expect(
        service.debitProfileAndCreditSystem(
          'profile-1',
          99999,
          WalletTransactionType.PENALTY_DEBIT,
          WalletTransactionType.CREDIT_PENALTY,
          'penalty',
          'pen-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  const MM_WALLET_ID = 'wallet-mm-1';
  const mockMobileMoneyWallet = {
    id: MM_WALLET_ID,
    owner_type: WalletOwnerType.MOBILE_MONEY,
    user_id: null,
    profile_id: null,
    balance: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };

  describe('getOrCreateMobileMoneyWallet()', () => {
    it('returns existing mobile money wallet when found', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(
        mockMobileMoneyWallet,
      );

      const result = await service.getOrCreateMobileMoneyWallet();

      expect(result.id).toBe(MM_WALLET_ID);
      expect(prisma.wallet.create).not.toHaveBeenCalled();
    });

    it('creates mobile money wallet when none exists', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.wallet.create as jest.Mock).mockResolvedValue(
        mockMobileMoneyWallet,
      );

      const result = await service.getOrCreateMobileMoneyWallet();

      expect(result.id).toBe(MM_WALLET_ID);
      expect(prisma.wallet.create).toHaveBeenCalledWith({
        data: { owner_type: WalletOwnerType.MOBILE_MONEY },
      });
    });
  });

  describe('getMobileMoneyBalance()', () => {
    it('returns balance, transactionCount, and operator/gateway breakdown', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        ...mockMobileMoneyWallet,
        balance: 75000,
      });
      (prisma.walletTransaction as any).findMany = jest.fn().mockResolvedValue([
        {
          amount: 50000,
          reference_type: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY',
        },
        {
          amount: 25000,
          reference_type: 'payment_request:MTN_MOMO:CG_AIRTELMONEY',
        },
      ]);
      (prisma.walletTransaction as any).count = jest.fn().mockResolvedValue(2);

      const result = await service.getMobileMoneyBalance();

      expect(result.balance).toBe(75000);
      expect(result.transactionCount).toBe(2);
      expect(result.byOperator['CG_MTNMOBILEMONEY']).toBe(50000);
      expect(result.byOperator['CG_AIRTELMONEY']).toBe(25000);
      expect(result.byGateway['MONETBIL']).toBe(50000);
      expect(result.byGateway['MTN_MOMO']).toBe(25000);
    });
  });

  describe('recordMobileMoneyWithdrawal()', () => {
    it('returns new balance and transaction id on success', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        ...mockMobileMoneyWallet,
        balance: 100000,
      });
      const txMock = {
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ balance: 50000 }),
        },
        walletTransaction: {
          create: jest.fn().mockResolvedValue({ id: 'tx-mm-1' }),
        },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      const result = await service.recordMobileMoneyWithdrawal(
        50000,
        'Bank transfer',
        'REF-123',
      );

      expect(result.walletId).toBe(MM_WALLET_ID);
      expect(result.newBalance).toBe(50000);
      expect(result.transactionId).toBe('tx-mm-1');
      expect(txMock.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: MM_WALLET_ID, balance: { gte: 50000 } },
        }),
      );
      expect(txMock.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: WalletTransactionType.MOBILE_MONEY_WITHDRAWAL,
            amount: 50000,
            reference_type: 'withdrawal:REF-123:Bank transfer',
          }),
        }),
      );
    });

    it('throws BadRequestException when balance insufficient', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue({
        ...mockMobileMoneyWallet,
        balance: 100,
      });
      const txMock = {
        wallet: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn(),
        },
        walletTransaction: { create: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb: any) =>
        cb(txMock),
      );

      await expect(
        service.recordMobileMoneyWithdrawal(50000),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listMobileMoneyTransactionsForAdmin()', () => {
    it('queries mobile money wallet and returns paginated result', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(
        mockMobileMoneyWallet,
      );
      const mockTx = {
        id: 'tx-mm-1',
        wallet_id: MM_WALLET_ID,
        type: WalletTransactionType.MOBILE_MONEY_CREDIT,
        amount: 10000,
        reference_type: 'payment_request:MONETBIL:CG_MTNMOBILEMONEY',
        reference_id: 'pr-1',
        created_at: new Date('2026-01-01'),
      };
      (prisma.walletTransaction as any).findMany = jest
        .fn()
        .mockResolvedValue([mockTx]);
      (prisma.walletTransaction as any).count = jest.fn().mockResolvedValue(1);

      const result = await service.listMobileMoneyTransactionsForAdmin({
        page: 1,
        limit: 20,
      });

      expect(result.total).toBe(1);
      expect(result.data[0].gateway).toBe('MONETBIL');
      expect(result.data[0].operator).toBe('CG_MTNMOBILEMONEY');
      expect(result.data[0].amount).toBe(10000);
      expect(
        (prisma.walletTransaction.findMany as jest.Mock).mock.calls[0][0].where
          .wallet_id,
      ).toBe(MM_WALLET_ID);
    });

    it('applies pagination skip/take math', async () => {
      (prisma.wallet.findFirst as jest.Mock).mockResolvedValue(
        mockMobileMoneyWallet,
      );
      (prisma.walletTransaction as any).findMany = jest
        .fn()
        .mockResolvedValue([]);
      (prisma.walletTransaction as any).count = jest.fn().mockResolvedValue(0);

      await service.listMobileMoneyTransactionsForAdmin({ page: 3, limit: 10 });

      const call = (prisma.walletTransaction.findMany as jest.Mock).mock
        .calls[0][0];
      expect(call.skip).toBe(20);
      expect(call.take).toBe(10);
    });
  });
});
