import { Test, TestingModule } from '@nestjs/testing';
import {
  PaymentRequestPublicController,
  boundedPayload,
} from '../payment-request-public.controller';
import { PaymentRequestService } from '../payment-request.service';
import { LogService } from '../../log/log.service';

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

describe('PaymentRequestPublicController', () => {
  let controller: PaymentRequestPublicController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentRequestPublicController],
      providers: [
        { provide: PaymentRequestService, useValue: mockService },
        { provide: LogService, useValue: mockLogService },
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

  it('paymentCallback handles Monetbil callback', async () => {
    const result = await controller.paymentCallback({
      paymentId: 'gw-1',
      status: '1',
    });
    expect(mockService.handlePaymentCallback).toHaveBeenCalled();
    expect(mockLogService.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_WEBHOOK_RECEIVED' }),
    );
    expect(result).toEqual({ status: 'COMPLETED' });
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
    const body = { paymentId: 'gw-1', status: '1' };
    await controller.paymentCallback(body);
    expect(mockLogService.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { payload: body } }),
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
