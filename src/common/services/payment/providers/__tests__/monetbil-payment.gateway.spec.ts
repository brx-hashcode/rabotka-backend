import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MonetbilPaymentGateway } from '../monetbil-payment.gateway';

const mockConfig = {
  get: jest.fn().mockReturnValue('test-service-key'),
};

const makeFetchResponse = (data: unknown, ok = true) => ({
  ok,
  json: jest.fn().mockResolvedValue(data),
});

describe('MonetbilPaymentGateway', () => {
  let gateway: MonetbilPaymentGateway;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonetbilPaymentGateway,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    gateway = module.get<MonetbilPaymentGateway>(MonetbilPaymentGateway);
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('initiatePayment', () => {
    const params = {
      amount: 1000,
      phone: '+242001',
      currency: 'XAF',
      externalId: 'ext-1',
      metadata: { operator: 'MTN', userName: 'Alice', email: 'alice@test.com' },
    };

    it('returns gatewayRef and PENDING on success', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ paymentId: 'gw-123', status: 'REQUEST_ACCEPTED' }));
      const result = await gateway.initiatePayment(params);
      expect(result.status).toBe('PENDING');
      expect(result.gatewayRef).toBe('gw-123');
    });

    it('uses externalId when no paymentId in response', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 'REQUEST_ACCEPTED' }));
      const result = await gateway.initiatePayment(params);
      expect(result.gatewayRef).toBe('ext-1');
    });

    it('throws when status is REQUEST_FAILED', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ status: 'REQUEST_FAILED', message: 'Invalid key' }));
      await expect(gateway.initiatePayment(params)).rejects.toThrow('Invalid key');
    });

    it('throws when response is not ok', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ message: 'Server error' }, false));
      await expect(gateway.initiatePayment(params)).rejects.toThrow();
    });

    it('rethrows fetch errors', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network error'));
      await expect(gateway.initiatePayment(params)).rejects.toThrow('network error');
    });

    it('wraps non-Error fetch failures', async () => {
      fetchSpy.mockRejectedValueOnce('raw string error');
      await expect(gateway.initiatePayment(params)).rejects.toThrow();
    });
  });

  describe('checkPaymentStatus', () => {
    it('returns COMPLETED for status 1', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '1', transaction_id: 'tx-1' } }));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('COMPLETED');
      expect(result.transactionId).toBe('tx-1');
    });

    it('returns FAILED for status 0', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '0' } }));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('FAILED');
    });

    it('returns CANCELLED for status -1', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '-1' } }));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('CANCELLED');
    });

    it('returns PENDING for unknown status', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '99' } }));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('PENDING');
    });

    it('returns PENDING when no transaction in response', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({}));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('PENDING');
    });

    it('returns PENDING on fetch error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network error'));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('PENDING');
    });
  });

  describe('handleWebhookPayload', () => {
    it('re-verifies and returns status', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '1', transaction_id: 'tx-42' } }));
      const result = await gateway.handleWebhookPayload({ paymentId: 'gw-1', transaction_id: 'tx-42' });
      expect(result.status).toBe('COMPLETED');
      expect(result.gatewayRef).toBe('gw-1');
    });

    it('uses payment_ref when no paymentId', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse({ transaction: { status: '0' } }));
      const result = await gateway.handleWebhookPayload({ payment_ref: 'gw-ref-2' });
      expect(result.gatewayRef).toBe('gw-ref-2');
    });

    it('uses PENDING status as PENDING', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('err')); // triggers PENDING in checkPaymentStatus
      const result = await gateway.handleWebhookPayload({ paymentId: 'gw-1' });
      expect(result.status).toBe('PENDING');
    });
  });
});
