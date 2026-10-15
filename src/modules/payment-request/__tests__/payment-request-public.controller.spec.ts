import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentRequestPublicController,
  boundedPayload,
} from '../payment-request-public.controller';
import { PaymentRequestService } from '../payment-request.service';
import { LogService } from '../../log/log.service';
import { UnauthorizedException } from '@nestjs/common';
import { PawapaySignatureVerifier } from '../../../common/services/payment/providers/pawapay-signature';

const mockService = {
  getByToken: jest
    .fn()
    .mockResolvedValue({ id: 'pr-1', token: 'tok-1', status: 'PENDING' }),
  initiatePayment: jest.fn().mockResolvedValue({ success: true }),
  handlePaymentCallback: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
};

const mockLogService = {
  create: jest.fn().mockResolvedValue(undefined),
};

const mockVerifier = { verify: jest.fn().mockResolvedValue(undefined) };

/** A request as Nest hands it to the controller, raw body included. */
const signedReq = (body: unknown) =>
  ({
    method: 'POST',
    headers: { host: 'api.rabotka.test', 'content-type': 'application/json' },
    originalUrl: '/api/v1/webhooks/payment/pawapay?x=1',
    url: '/webhooks/payment/pawapay',
    rawBody: Buffer.from(JSON.stringify(body)),
  }) as never;

describe('PaymentRequestPublicController', () => {
  let controller: PaymentRequestPublicController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentRequestPublicController],
      providers: [
        { provide: PaymentRequestService, useValue: mockService },
        { provide: LogService, useValue: mockLogService },
        { provide: PawapaySignatureVerifier, useValue: mockVerifier },
      ],
    }).compile();
    controller = module.get<PaymentRequestPublicController>(
      PaymentRequestPublicController,
    );
  });

  it('getByToken returns payment request data', async () => {
    const result = await controller.getByToken('tok-1');
    expect(mockService.getByToken).toHaveBeenCalledWith('tok-1');
    expect(result).toMatchObject({ token: 'tok-1' });
  });

  it('initiatePayment calls service and logs', async () => {
    const result = await controller.initiatePayment('tok-1', {
      phone: '+242001',
      operator: 'MTN',
    });
    expect(mockService.initiatePayment).toHaveBeenCalledWith(
      'tok-1',
      '+242001',
      'MTN',
    );
    expect(mockLogService.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_INITIATED' }),
    );
    expect(result).toEqual({ success: true });
  });

  describe('pawaPay deposit callback', () => {
    const body = { depositId: 'dep-1', status: 'COMPLETED' };

    it('verifies the signature on the raw request, then processes it', async () => {
      const result = await controller.pawapayDepositCallback(
        signedReq(body),
        body,
      );

      expect(mockVerifier.verify).toHaveBeenCalledWith({
        method: 'POST',
        authority: 'api.rabotka.test',
        // The path as received, prefix included, query dropped.
        path: '/api/v1/webhooks/payment/pawapay',
        headers: expect.objectContaining({ host: 'api.rabotka.test' }),
        rawBody: Buffer.from(JSON.stringify(body)),
      });
      expect(mockService.handlePaymentCallback).toHaveBeenCalledWith(body);
      expect(mockLogService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYMENT_WEBHOOK_RECEIVED',
          metadata: expect.objectContaining({ gateway: 'PAWAPAY' }),
        }),
      );
      expect(result).toEqual({ status: 'COMPLETED' });
    });

    it('refuses an unsigned or forged callback without touching the payment', async () => {
      mockVerifier.verify.mockRejectedValueOnce(
        new UnauthorizedException('Invalid callback signature'),
      );

      await expect(
        controller.pawapayDepositCallback(signedReq(body), body),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockService.handlePaymentCallback).not.toHaveBeenCalled();
      expect(mockLogService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_WEBHOOK_REJECTED' }),
      );
    });

    it('turns any verification error into a 401', async () => {
      mockVerifier.verify.mockRejectedValueOnce(new Error('keys unreachable'));
      await expect(
        controller.pawapayDepositCallback(signedReq(body), body),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockService.handlePaymentCallback).not.toHaveBeenCalled();
    });
  });

  describe('pawaPay payout callback', () => {
    const body = { payoutId: 'pay-1', status: 'COMPLETED' };

    it('is verified and only recorded, since nothing initiates payouts yet', async () => {
      const result = await controller.pawapayPayoutCallback(
        signedReq(body),
        body,
      );
      expect(mockVerifier.verify).toHaveBeenCalled();
      expect(mockService.handlePaymentCallback).not.toHaveBeenCalled();
      expect(mockLogService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYOUT_WEBHOOK_RECEIVED' }),
      );
      expect(result).toEqual({ received: true });
    });

    it('refuses an unsigned payout callback', async () => {
      mockVerifier.verify.mockRejectedValueOnce(
        new UnauthorizedException('Invalid callback signature'),
      );
      await expect(
        controller.pawapayPayoutCallback(signedReq(body), body),
      ).rejects.toThrow(UnauthorizedException);
      expect(mockLogService.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYOUT_WEBHOOK_RECEIVED' }),
      );
    });
  });

  it('mtnMomoCallback handles MTN webhook', async () => {
    const result = await controller.mtnMomoCallback({ externalId: 'gw-ref-1' });
    expect(mockService.handlePaymentCallback).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ gateway: 'MTN_MOMO' }),
      }),
    );
    expect(result).toEqual({ status: 'COMPLETED' });
  });

  it('keeps a callback body of a normal size whole in the log', async () => {
    const body = { depositId: 'dep-1', status: 'COMPLETED' };
    await controller.pawapayDepositCallback(signedReq(body), body);
    expect(mockLogService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { gateway: 'PAWAPAY', payload: body },
      }),
    );
  });
});

describe('boundedPayload', () => {
  it('returns a provider-sized body unchanged', () => {
    const body = { paymentId: 'gw-1', transaction_id: 'tx-1' };
    expect(boundedPayload(body)).toBe(body);
  });

  it('truncates a body far larger than any provider sends', () => {
    // Anyone can post here; a megabyte body must not become a megabyte row.
    const stored = boundedPayload({ junk: 'x'.repeat(1_000_000) });
    expect(typeof stored).toBe('string');
    expect((stored as string).length).toBeLessThan(4_100);
    expect(stored).toMatch(/\[truncated, \d+ chars\]$/);
  });

  it('survives a body that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(boundedPayload(circular)).toBe('[unserialisable payload]');
  });
});
