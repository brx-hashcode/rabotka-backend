import { MonetbilService } from '../monetbil.service';

global.fetch = jest.fn();

describe('MonetbilService', () => {
  let service: MonetbilService;

  const baseParams = {
    serviceKey: 'svc-key',
    amount: 5000,
    phonenumber: '069917686',
    operator: 'CG_MTNMOBILEMONEY',
    user: 'Jean Dupont',
    email: 'jean@example.com',
  };

  beforeEach(() => {
    service = new MonetbilService();
    jest.clearAllMocks();
  });

  describe('initiatePayment()', () => {
    it('returns success with paymentId when API responds REQUEST_ACCEPTED', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'REQUEST_ACCEPTED',
          message: 'payment pending',
          paymentId: '26041200203011759687',
        }),
      });

      const result = await service.initiatePayment(baseParams);

      expect(result.success).toBe(true);
      expect(result.paymentId).toBe('26041200203011759687');
      expect(result.message).toBe('USSD push initiated');
    });

    it('returns failure when API returns REQUEST_FAILED', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'REQUEST_FAILED',
          message: 'Invalid phone',
        }),
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
        json: async () => ({ status: 'REQUEST_ACCEPTED', paymentId: '123' }),
      });

      await service.initiatePayment(baseParams);

      const [url, options] = (fetch as jest.Mock).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toBe('https://api.monetbil.com/payment/v1/placePayment');
      expect(options.method).toBe('POST');
      const body = options.body as string;
      expect(body).toContain('service=svc-key');
      expect(body).toContain('amount=5000');
      expect(body).toContain('phonenumber=069917686');
      expect(body).toContain('operator=CG_MTNMOBILEMONEY');
      expect(body).toContain('country=CG');
      expect(body).toContain('currency=XAF');
      expect(body).toContain('user=Jean+Dupont');
      expect(body).toContain('email=jean%40example.com');
      expect(body).not.toContain('notify_url');
    });
  });

  describe('checkPayment()', () => {
    it('returns SUCCESS when transaction.status is "1"', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transaction: { status: '1', transaction_id: 'TX123' },
        }),
      });
      const result = await service.checkPayment('PAY123');
      expect(result.status).toBe('SUCCESS');
      expect(result.transactionId).toBe('TX123');
    });

    it('returns FAILED when transaction.status is "0"', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: { status: '0' } }),
      });
      expect((await service.checkPayment('PAY123')).status).toBe('FAILED');
    });

    it('returns CANCELLED when transaction.status is "-1"', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transaction: { status: '-1' } }),
      });
      expect((await service.checkPayment('PAY123')).status).toBe('CANCELLED');
    });

    it('returns PENDING when no transaction status yet', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });
      expect((await service.checkPayment('PAY123')).status).toBe('PENDING');
    });

    it('returns PENDING on network error', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
      expect((await service.checkPayment('PAY123')).status).toBe('PENDING');
    });
  });
});
