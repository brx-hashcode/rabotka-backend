import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, PayoutStatus, WalletTransactionType } from '@prisma/client';
import { MobileMoneyPayoutService } from '../mobile-money-payout.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const ADMIN = 'admin-1';
const REQ = '11111111-1111-4111-8111-111111111111';

const payoutRow = (over: Record<string, unknown> = {}) => ({
  id: 'po-1',
  created_at: new Date('2026-10-16T10:00:00Z'),
  updated_at: new Date('2026-10-16T10:00:00Z'),
  client_request_id: REQ,
  amount: new Prisma.Decimal(5000),
  currency: 'XAF',
  phone: '+242061234567',
  operator: 'MTN_MOMO_COG',
  country: 'COG',
  note: 'Retrait',
  status: PayoutStatus.PENDING,
  gateway: 'PAWAPAY',
  gateway_ref: 'gw-1',
  gateway_tx_id: null,
  failure_reason: null,
  completed_at: null,
  requested_by_id: ADMIN,
  requested_by: { first_name: 'Jean', last_name: 'ITOUA' },
  ...over,
});

function setup() {
  const tx = {
    mobileMoneyPayout: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wallet: { update: jest.fn().mockResolvedValue({}) },
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    mobileMoneyPayout: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue(payoutRow({ gateway_ref: null })),
      update: jest.fn().mockResolvedValue(payoutRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    supportsPayouts: jest.fn().mockReturnValue(true),
    getActiveMetadata: jest.fn().mockReturnValue({
      key: 'PAWAPAY',
      label: 'pawaPay',
      requiresOperator: true,
      operators: [
        { code: 'MTN_MOMO_COG', label: 'MTN Mobile Money', country: 'COG' },
      ],
    }),
    // The live networks the payout is checked against, with their franc.
    activeOperators: jest.fn().mockResolvedValue([
      {
        code: 'MTN_MOMO_COG',
        label: 'MTN',
        country: 'COG',
        dialCode: '242',
        currency: 'XAF',
      },
      {
        code: 'ORANGE_SEN',
        label: 'Orange',
        country: 'SEN',
        dialCode: '221',
        currency: 'XOF',
      },
    ]),
    getBalances: jest
      .fn()
      .mockResolvedValue([
        { country: 'COG', currency: 'XAF', balance: '20000.00' },
      ]),
    initiatePayout: jest
      .fn()
      .mockResolvedValue({ gatewayRef: 'gw-1', status: 'INITIATED' }),
    checkPayoutStatus: jest.fn(),
  };
  const wallet = {
    getMobileMoneyBalance: jest.fn().mockResolvedValue({ balance: 100000 }),
    getOrCreateMobileMoneyWallet: jest
      .fn()
      .mockResolvedValue({ id: 'mm-wallet' }),
  };
  const log = { create: jest.fn().mockResolvedValue(undefined) };
  const service = new MobileMoneyPayoutService(
    prisma as never,
    gateway as never,
    wallet as never,
    log as never,
  );
  return { service, prisma, tx, gateway, wallet, log };
}

const input = (over: Record<string, unknown> = {}) => ({
  clientRequestId: REQ,
  amount: 5000,
  confirmAmount: 5000,
  phone: '+242061234567',
  operator: 'MTN_MOMO_COG',
  note: 'Retrait',
  adminId: ADMIN,
  ...over,
});

describe('MobileMoneyPayoutService', () => {
  describe('send()', () => {
    it('sends the payout and keeps the gateway reference', async () => {
      const { service, prisma, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique
        .mockResolvedValueOnce(null) // no previous request
        .mockResolvedValueOnce(payoutRow()); // reload

      const res = await service.send(input());

      expect(gateway.initiatePayout).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 5000,
          currency: 'XAF',
          phone: '+242061234567',
          operator: 'MTN_MOMO_COG',
        }),
      );
      expect(prisma.mobileMoneyPayout.update).toHaveBeenCalledWith({
        where: { id: 'po-1' },
        data: { gateway_ref: 'gw-1' },
      });
      expect(res).toMatchObject({
        status: 'PENDING',
        gatewayRef: 'gw-1',
        requestedBy: 'Jean ITOUA',
      });
    });

    it('pays a network in its own franc: XOF for Sénégal, against the XOF balance', async () => {
      const { service, prisma, gateway } = setup();
      gateway.getBalances.mockResolvedValueOnce([
        { country: 'SEN', currency: 'XOF', balance: '20000.00' },
      ]);
      prisma.mobileMoneyPayout.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(payoutRow());

      await service.send({
        ...input(),
        phone: '+221771234567',
        operator: 'ORANGE_SEN',
      });

      expect(gateway.getBalances).toHaveBeenCalledWith('SEN');
      expect(gateway.initiatePayout).toHaveBeenCalledWith(
        expect.objectContaining({ operator: 'ORANGE_SEN', currency: 'XOF' }),
      );
    });

    it('never sends twice for the same request id', async () => {
      const { service, prisma, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(payoutRow());

      const res = await service.send(input());

      expect(gateway.initiatePayout).not.toHaveBeenCalled();
      expect(res.id).toBe('po-1');
    });

    it('refuses when the confirmation amount differs', async () => {
      const { service, gateway } = setup();
      await expect(
        service.send(input({ confirmAmount: 50000 })),
      ).rejects.toThrow('Le montant de confirmation ne correspond pas.');
      expect(gateway.initiatePayout).not.toHaveBeenCalled();
    });

    it('refuses more than the ledger holds', async () => {
      const { service, wallet, gateway } = setup();
      wallet.getMobileMoneyBalance.mockResolvedValue({ balance: 1000 });
      await expect(service.send(input())).rejects.toThrow(
        /registre insuffisant/,
      );
      expect(gateway.initiatePayout).not.toHaveBeenCalled();
    });

    it('refuses more than the gateway actually holds', async () => {
      const { service, gateway } = setup();
      gateway.getBalances.mockResolvedValue([
        { country: 'COG', currency: 'XAF', balance: '17.28' },
      ]);
      await expect(service.send(input())).rejects.toThrow(
        /pawaPay insuffisant/,
      );
      expect(gateway.initiatePayout).not.toHaveBeenCalled();
    });

    it('sends nothing when the live balance cannot be read', async () => {
      const { service, gateway } = setup();
      gateway.getBalances.mockRejectedValue(new Error('down'));
      await expect(service.send(input())).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(gateway.initiatePayout).not.toHaveBeenCalled();
    });

    it('refuses an operator the gateway does not route', async () => {
      const { service } = setup();
      await expect(
        service.send(input({ operator: 'ORANGE_CMR' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses when the active gateway cannot send money', async () => {
      const { service, gateway } = setup();
      gateway.supportsPayouts.mockReturnValue(false);
      await expect(service.send(input())).rejects.toThrow(ConflictException);
    });

    it('marks the payout FAILED when the gateway refuses it', async () => {
      const { service, prisma, gateway } = setup();
      gateway.initiatePayout.mockRejectedValue(
        new BadRequestException('Numéro de téléphone invalide.'),
      );

      await expect(service.send(input())).rejects.toThrow(
        'Numéro de téléphone invalide.',
      );
      expect(prisma.mobileMoneyPayout.update).toHaveBeenCalledWith({
        where: { id: 'po-1' },
        data: {
          status: PayoutStatus.FAILED,
          failure_reason: 'Numéro de téléphone invalide.',
        },
      });
    });
  });

  describe('settling', () => {
    it('debits the ledger once when the gateway says COMPLETED', async () => {
      const { service, prisma, tx, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(payoutRow());
      gateway.checkPayoutStatus.mockResolvedValue({
        gatewayRef: 'gw-1',
        status: 'COMPLETED',
        transactionId: 'mtn-9',
      });

      await service.refresh('po-1');

      expect(tx.mobileMoneyPayout.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'po-1', status: PayoutStatus.PENDING },
          data: expect.objectContaining({
            status: PayoutStatus.COMPLETED,
            gateway_tx_id: 'mtn-9',
          }),
        }),
      );
      expect(tx.wallet.update).toHaveBeenCalledWith({
        where: { id: 'mm-wallet' },
        data: { balance: { decrement: 5000 } },
      });
      expect(tx.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: WalletTransactionType.MOBILE_MONEY_WITHDRAWAL,
          reference_type: 'withdrawal:PAWAPAY:Retrait',
          reference_id: 'po-1',
        }),
      });
    });

    it('does not debit again when another settlement got there first', async () => {
      const { service, prisma, tx, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(payoutRow());
      gateway.checkPayoutStatus.mockResolvedValue({
        gatewayRef: 'gw-1',
        status: 'COMPLETED',
      });
      tx.mobileMoneyPayout.updateMany.mockResolvedValue({ count: 0 });

      await service.refresh('po-1');

      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('marks a failed payout FAILED and never touches the ledger', async () => {
      const { service, prisma, tx, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(payoutRow());
      gateway.checkPayoutStatus.mockResolvedValue({
        gatewayRef: 'gw-1',
        status: 'FAILED',
        failureReason: 'RECIPIENT_NOT_FOUND',
      });

      await service.refresh('po-1');

      expect(prisma.mobileMoneyPayout.updateMany).toHaveBeenCalledWith({
        where: { id: 'po-1', status: PayoutStatus.PENDING },
        data: {
          status: PayoutStatus.FAILED,
          failure_reason: 'RECIPIENT_NOT_FOUND',
        },
      });
      expect(tx.wallet.update).not.toHaveBeenCalled();
    });

    it('leaves a still-processing payout pending', async () => {
      const { service, prisma, tx, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(payoutRow());
      gateway.checkPayoutStatus.mockResolvedValue({
        gatewayRef: 'gw-1',
        status: 'PENDING',
      });

      await service.refresh('po-1');

      expect(tx.mobileMoneyPayout.updateMany).not.toHaveBeenCalled();
      expect(prisma.mobileMoneyPayout.updateMany).not.toHaveBeenCalled();
    });

    it('acts on a callback only for a pending payout, re-reading its status', async () => {
      const { service, prisma, gateway } = setup();
      prisma.mobileMoneyPayout.findUnique.mockResolvedValue(
        payoutRow({ status: PayoutStatus.COMPLETED }),
      );

      await service.handleCallback({ payoutId: 'gw-1', status: 'FAILED' });

      expect(gateway.checkPayoutStatus).not.toHaveBeenCalled();
    });

    it('re-checks stale pending payouts when the list is read', async () => {
      const { service, prisma, gateway } = setup();
      prisma.mobileMoneyPayout.findMany
        .mockResolvedValueOnce([payoutRow()]) // stale pending
        .mockResolvedValueOnce([]); // the page itself
      gateway.checkPayoutStatus.mockResolvedValue({
        gatewayRef: 'gw-1',
        status: 'PENDING',
      });

      await service.list({ page: 1, limit: 20 });

      expect(gateway.checkPayoutStatus).toHaveBeenCalledWith('gw-1');
    });
  });
});
