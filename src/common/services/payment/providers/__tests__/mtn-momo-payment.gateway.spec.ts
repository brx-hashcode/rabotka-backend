import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MtnMomoPaymentGateway } from '../mtn-momo-payment.gateway';

const mockConfig = {
  get: jest.fn().mockImplementation((key: string, def = '') => {
    const map: Record<string, string> = {
      MTN_MOMO_BASE_URL: 'https://sandbox.momodeveloper.mtn.com',
      MTN_MOMO_COLLECTION_API_USER: 'api-user',
      MTN_MOMO_COLLECTION_API_KEY: 'api-key',
      MTN_MOMO_COLLECTION_PRIMARY_KEY: 'primary-key',
      MTN_MOMO_ENVIRONMENT: 'sandbox',
      MTN_MOMO_CALLBACK_URL: 'https://callback.test',
    };
    return map[key] ?? def;
  }),
};

const makeResponse = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(data),
  text: jest.fn().mockResolvedValue('error text'),
});

describe('MtnMomoPaymentGateway', () => {
  let gateway: MtnMomoPaymentGateway;
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MtnMomoPaymentGateway,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    gateway = module.get<MtnMomoPaymentGateway>(MtnMomoPaymentGateway);
    (gateway as any).cachedToken = null;
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('initiatePayment', () => {
    const params = {
      amount: 5000,
      phone: '+242001',
      currency: 'XAF',
      externalId: 'ext-1',
      description: 'Test payment',
    };

    it('initiates payment and returns gatewayRef', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          makeResponse({ access_token: 'tok', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(makeResponse({}, true, 202));
      const result = await gateway.initiatePayment(params);
      expect(result.status).toBe('PENDING');
      expect(result.gatewayRef).toBeDefined();
    });

    it('throws when requesttopay returns non-202', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          makeResponse({ access_token: 'tok', expires_in: 3600 }),
        )
        .mockResolvedValueOnce(makeResponse({}, false, 400));
      await expect(gateway.initiatePayment(params)).rejects.toThrow();
    });

    it('throws when token fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse({}, false, 401));
      await expect(gateway.initiatePayment(params)).rejects.toThrow();
    });

    it('uses cached token on second call', async () => {
      (gateway as any).cachedToken = {
        value: 'cached-tok',
        expiresAt: Date.now() + 99999,
      };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      const result = await gateway.initiatePayment(params);
      expect(result.status).toBe('PENDING');
      // Only 1 fetch call (no token refresh)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('sends trailing slash on requesttopay URL', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment(params);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toMatch(/\/requesttopay\/$/);
    });

    it('sends Host header on requesttopay', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment(params);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['Host']).toBe('sandbox.momodeveloper.mtn.com');
    });

    it('prepends 242 to local phone number', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment({ ...params, phone: '061234567' });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.payer.partyId).toBe('242061234567');
    });

    it('does not double-prefix 242 when already present', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment({ ...params, phone: '242061234567' });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.payer.partyId).toBe('242061234567');
    });

    it('normalizes +242 prefix', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment({ ...params, phone: '+242061234567' });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.payer.partyId).toBe('242061234567');
    });

    it('uses description as payerMessage and payeeNote', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      await gateway.initiatePayment({ ...params, description: 'Recharge du wallet — 5 000 FCFA' });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.payerMessage).toBe('Recharge du wallet — 5 000 FCFA');
      expect(body.payeeNote).toBe('Recharge du wallet — 5 000 FCFA');
    });

    it('falls back to Paiement Rabotka when no description', async () => {
      (gateway as any).cachedToken = { value: 'tok', expiresAt: Date.now() + 99999 };
      fetchSpy.mockResolvedValueOnce(makeResponse({}, true, 202));
      const { description: _, ...noDesc } = params;
      await gateway.initiatePayment(noDesc);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.payerMessage).toBe('Paiement Rabotka');
    });
  });

  describe('checkPaymentStatus', () => {
    beforeEach(() => {
      (gateway as any).cachedToken = {
        value: 'tok',
        expiresAt: Date.now() + 99999,
      };
    });

    it('returns COMPLETED for SUCCESSFUL', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse({ status: 'SUCCESSFUL', financialTransactionId: 'tx-1' }),
      );
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('COMPLETED');
      expect(result.transactionId).toBe('tx-1');
    });

    it('returns FAILED for FAILED', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse({ status: 'FAILED', reason: 'declined' }),
      );
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('FAILED');
    });

    it('returns PENDING for unknown status', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse({ status: 'PENDING' }));
      const result = await gateway.checkPaymentStatus('gw-1');
      expect(result.status).toBe('PENDING');
    });

    it('returns PENDING when response not ok', async () => {
      fetchSpy.mockResolvedValueOnce(makeResponse({}, false, 404));
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
    beforeEach(() => {
      (gateway as any).cachedToken = {
        value: 'tok',
        expiresAt: Date.now() + 99999,
      };
    });

    it('re-verifies and returns status using externalId as fallback', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse({ status: 'SUCCESSFUL', financialTransactionId: 'tx-1' }),
      );
      const result = await gateway.handleWebhookPayload({ externalId: 'gw-1' });
      expect(result.status).toBe('COMPLETED');
      expect(result.gatewayRef).toBe('gw-1');
    });

    it('prefers referenceId over externalId for status check', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeResponse({ status: 'SUCCESSFUL', financialTransactionId: 'tx-2' }),
      );
      const result = await gateway.handleWebhookPayload({
        referenceId: 'uuid-ref',
        externalId: 'db-id',
      });
      expect(result.gatewayRef).toBe('uuid-ref');
      expect(result.status).toBe('COMPLETED');
    });

    it('uses referenceId when no externalId', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('err'));
      const result = await gateway.handleWebhookPayload({
        referenceId: 'ref-1',
      });
      expect(result.gatewayRef).toBe('ref-1');
      expect(result.status).toBe('PENDING');
    });
  });
});
