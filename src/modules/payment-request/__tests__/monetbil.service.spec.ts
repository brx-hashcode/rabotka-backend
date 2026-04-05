import { MonetbilService } from '../monetbil.service';
import { createHmac } from 'node:crypto';

global.fetch = jest.fn();

function makePayload(overrides: Record<string, string> = {}) {
  return {
    payment_ref: 'REF123',
    amount: '5000',
    phone: '237600000001',
    ...overrides,
  };
}

function signPayload(
  payload: Record<string, string>,
  secret: string,
): Record<string, string> {
  const { payment_ref, amount, phone } = payload;
  const signature = createHmac('sha256', secret)
    .update(`${payment_ref}${amount}${phone}`)
    .digest('hex');
  return { ...payload, signature };
}

describe('MonetbilService', () => {
  let service: MonetbilService;

  beforeEach(() => {
    service = new MonetbilService();
    jest.clearAllMocks();
  });

  describe('initiatePayment()', () => {
    const baseParams = {
      serviceId: 'svc-id',
      serviceSecret: 'svc-secret',
      amount: 5000,
      phone: '237600000001',
      operator: 'MTN',
      paymentRef: 'REF123',
      notifyUrl: 'https://example.com/webhook',
    };

    it('returns success when API responds OK', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const result = await service.initiatePayment(baseParams);

      expect(result.success).toBe(true);
      expect(result.paymentRef).toBe('REF123');
      expect(result.message).toBe('USSD push initiated');
    });

    it('returns failure when API returns success=false', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false, message: 'Invalid phone' }),
      });

      const result = await service.initiatePayment(baseParams);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid phone');
    });

    it('returns failure when HTTP status is not ok', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Unauthorized' }),
      });

      const result = await service.initiatePayment(baseParams);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unauthorized');
    });

    it('returns failure on network error', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network failure'));

      const result = await service.initiatePayment(baseParams);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Monetbil');
    });

    it('sends correct form body to Monetbil API', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await service.initiatePayment(baseParams);

      const [url, options] = (fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api2.monetbil.com/payment/v1/placePayment');
      expect(options.method).toBe('POST');
      const body = options.body as string;
      expect(body).toContain('service=svc-id');
      expect(body).toContain('amount=5000');
      expect(body).toContain('phone=237600000001');
      expect(body).toContain('operator=MTN');
      expect(body).toContain('payment_ref=REF123');
    });
  });

  describe('verifyWebhookSignature()', () => {
    const secret = 'my-secret';

    it('returns true for a valid HMAC signature', () => {
      const payload = signPayload(makePayload(), secret);
      expect(service.verifyWebhookSignature(payload, secret)).toBe(true);
    });

    it('returns false when signature does not match', () => {
      const payload = signPayload(makePayload(), secret);
      payload.signature = 'badsignature';
      expect(service.verifyWebhookSignature(payload, secret)).toBe(false);
    });

    it('returns false when signature is missing', () => {
      const payload = makePayload(); // no signature field
      expect(service.verifyWebhookSignature(payload, secret)).toBe(false);
    });

    it('returns false when amount is tampered', () => {
      const payload = signPayload(makePayload(), secret);
      payload.amount = '9999'; // tampered
      expect(service.verifyWebhookSignature(payload, secret)).toBe(false);
    });

    it('returns false when wrong secret used', () => {
      const payload = signPayload(makePayload(), 'wrong-secret');
      expect(service.verifyWebhookSignature(payload, secret)).toBe(false);
    });
  });
});
