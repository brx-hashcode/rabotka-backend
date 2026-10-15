import { BadRequestException, Logger } from '@nestjs/common';
import {
  PawapayPaymentGateway,
  buildDepositMetadata,
  customerMessageFor,
  toMsisdn,
} from '../pawapay-payment.gateway';
import { fetchWithTimeout } from '../../../../utils/fetch-with-timeout.util';

jest.mock('../../../../utils/fetch-with-timeout.util', () => ({
  fetchWithTimeout: jest.fn(),
}));
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

const fetchMock = fetchWithTimeout as jest.Mock;

const config = {
  get: jest.fn(
    (key: string, fallback?: string) =>
      ({
        PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io/',
        PAWAPAY_API_TOKEN: 'tok',
      })[key] ?? fallback,
  ),
};

/** A pawaPay HTTP answer. */
const reply = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
});

const deposit = {
  amount: 1500,
  currency: 'XAF',
  externalId: 'req-1',
  phone: '06 123 45 67',
  operator: 'MTN_MOMO_COG',
  requestType: 'CONTACT_UNLOCK',
  payer: {
    profileId: 'prof-1',
    name: 'Jean ITOUA',
    email: 'jean@exemple.cg',
    profileType: 'EMPLOYER',
  },
};

const sentBody = (call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body as string);

describe('PawapayPaymentGateway', () => {
  let gateway: PawapayPaymentGateway;

  beforeEach(() => {
    jest.clearAllMocks();
    gateway = new PawapayPaymentGateway(config as never);
  });

  describe('initiatePayment (deposit, v2)', () => {
    it('sends the deposit with the payer as metadata', async () => {
      fetchMock.mockResolvedValue(reply(200, { status: 'ACCEPTED' }));

      const res = await gateway.initiatePayment(deposit);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.sandbox.pawapay.io/v2/deposits');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok');

      const body = sentBody();
      expect(body.depositId).toBe(res.gatewayRef);
      expect(body).toMatchObject({
        amount: '1500',
        currency: 'XAF',
        payer: {
          type: 'MMO',
          accountDetails: {
            phoneNumber: '242061234567',
            provider: 'MTN_MOMO_COG',
          },
        },
        clientReferenceId: 'req-1',
        customerMessage: 'Rabotka contact',
      });
      expect(body.metadata).toEqual([
        { paymentRequestId: 'req-1' },
        { requestType: 'CONTACT_UNLOCK' },
        { profileId: 'prof-1' },
        { profileType: 'EMPLOYER' },
        { payerName: 'Jean ITOUA', isPII: true },
        { payerPhone: '242061234567', isPII: true },
        { payerEmail: 'jean@exemple.cg', isPII: true },
        { operator: 'MTN_MOMO_COG' },
      ]);
      expect(res.status).toBe('INITIATED');
    });

    it('rounds the amount to whole francs (XAF has no decimals)', async () => {
      fetchMock.mockResolvedValue(reply(200, { status: 'ACCEPTED' }));
      await gateway.initiatePayment({ ...deposit, amount: 1499.6 });
      expect(sentBody().amount).toBe('1500');
    });

    it('takes a duplicate as already initiated', async () => {
      fetchMock.mockResolvedValue(reply(200, { status: 'DUPLICATE_IGNORED' }));
      expect((await gateway.initiatePayment(deposit)).status).toBe('INITIATED');
    });

    it('refuses with a readable reason when pawaPay rejects', async () => {
      fetchMock.mockResolvedValue(
        reply(200, {
          status: 'REJECTED',
          failureReason: { failureCode: 'INVALID_PHONE_NUMBER' },
        }),
      );
      await expect(gateway.initiatePayment(deposit)).rejects.toThrow(
        'Numéro de téléphone invalide.',
      );
    });

    it('keeps the code when the rejection has no readable reason', async () => {
      fetchMock.mockResolvedValue(
        reply(400, {
          status: 'REJECTED',
          failureReason: { failureCode: 'WEIRD' },
        }),
      );
      await expect(gateway.initiatePayment(deposit)).rejects.toThrow(/WEIRD/);
    });

    it.each([
      [
        'an unknown outcome (HTTP 500)',
        () => reply(500, { failureCode: 'UNKNOWN_ERROR' }),
      ],
      ['no response at all', () => Promise.reject(new Error('timeout'))],
    ])(
      'leaves %s pending, with the deposit id to check later',
      async (_, answer) => {
        fetchMock.mockImplementation(answer);
        const res = await gateway.initiatePayment(deposit);
        expect(res.status).toBe('PENDING');
        expect(res.gatewayRef).toMatch(/^[0-9a-f-]{36}$/);
      },
    );

    it('refuses an operator pawaPay does not route here', async () => {
      await expect(
        gateway.initiatePayment({ ...deposit, operator: 'CG_MTNMOBILEMONEY' }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('checkPaymentStatus (v2)', () => {
    const status = (body: unknown, code = 200) => {
      fetchMock.mockResolvedValue(reply(code, body));
      return gateway.checkPaymentStatus('dep-1');
    };

    it('reads /v2/deposits/{id}', async () => {
      await status({ status: 'FOUND', data: { status: 'PROCESSING' } });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.sandbox.pawapay.io/v2/deposits/dep-1',
      );
    });

    it('returns COMPLETED with the provider transaction and what was settled', async () => {
      const res = await status({
        status: 'FOUND',
        data: {
          status: 'COMPLETED',
          providerTransactionId: 'tx-9',
          amount: '1500.00',
          currency: 'XAF',
        },
      });
      expect(res).toMatchObject({
        status: 'COMPLETED',
        transactionId: 'tx-9',
        amount: 1500,
        currency: 'XAF',
      });
    });

    it('returns FAILED with the failure code', async () => {
      const res = await status({
        status: 'FOUND',
        data: {
          status: 'FAILED',
          failureReason: { failureCode: 'PAYER_NOT_FOUND' },
        },
      });
      expect(res).toMatchObject({
        status: 'FAILED',
        failureReason: 'PAYER_NOT_FOUND',
      });
    });

    it.each(['ACCEPTED', 'PROCESSING', 'IN_RECONCILIATION'])(
      'keeps %s pending',
      async (s) => {
        expect(
          (await status({ status: 'FOUND', data: { status: s } })).status,
        ).toBe('PENDING');
      },
    );

    it('fails a deposit pawaPay never took (NOT_FOUND)', async () => {
      expect((await status({ status: 'NOT_FOUND' })).status).toBe('FAILED');
    });

    it('stays pending when pawaPay cannot be read', async () => {
      expect((await status({}, 503)).status).toBe('PENDING');
      fetchMock.mockRejectedValue(new Error('down'));
      expect((await gateway.checkPaymentStatus('dep-1')).status).toBe(
        'PENDING',
      );
    });
  });

  describe('handleWebhookPayload', () => {
    it('re-reads the status instead of trusting the body', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { status: 'FOUND', data: { status: 'FAILED' } }),
      );
      // The body claims success; the API says otherwise, and wins.
      const res = await gateway.handleWebhookPayload({
        depositId: 'dep-1',
        status: 'COMPLETED',
      });
      expect(res).toMatchObject({ gatewayRef: 'dep-1', status: 'FAILED' });
    });

    it('ignores a body without a deposit id', async () => {
      const res = await gateway.handleWebhookPayload({ status: 'COMPLETED' });
      expect(res.gatewayRef).toBe('');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('payouts (v2)', () => {
    it('sends the payout to the recipient', async () => {
      fetchMock.mockResolvedValue(reply(200, { status: 'ACCEPTED' }));
      const res = await gateway.initiatePayout({
        amount: 5000,
        currency: 'XAF',
        externalId: 'wd-1',
        phone: '+242 05 555 12 12',
        operator: 'AIRTEL_COG',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.sandbox.pawapay.io/v2/payouts',
      );
      expect(sentBody()).toMatchObject({
        payoutId: res.gatewayRef,
        amount: '5000',
        recipient: {
          type: 'MMO',
          accountDetails: {
            phoneNumber: '242055551212',
            provider: 'AIRTEL_COG',
          },
        },
      });
      expect(res.status).toBe('INITIATED');
    });

    it('checks a payout on /v2/payouts/{id}', async () => {
      fetchMock.mockResolvedValue(
        reply(200, {
          status: 'FOUND',
          data: { status: 'COMPLETED', providerTransactionId: 'tx' },
        }),
      );
      const res = await gateway.checkPayoutStatus('pay-1');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.sandbox.pawapay.io/v2/payouts/pay-1',
      );
      expect(res).toMatchObject({ status: 'COMPLETED', transactionId: 'tx' });
    });

    it('keeps an ENQUEUED payout pending', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { status: 'FOUND', data: { status: 'ENQUEUED' } }),
      );
      expect((await gateway.checkPayoutStatus('pay-1')).status).toBe('PENDING');
    });
  });

  describe('balances (v1)', () => {
    it('reads one country on the v1 API', async () => {
      fetchMock.mockResolvedValue(
        reply(200, {
          balances: [
            { country: 'COG', balance: '21798.03', currency: 'XAF', mno: '' },
            {
              country: 'COG',
              balance: '10.00',
              currency: 'XAF',
              mno: 'MTN_MOMO_COG',
            },
          ],
        }),
      );
      const res = await gateway.getBalances('COG');
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.sandbox.pawapay.io/v1/wallet-balances/COG',
      );
      expect(res).toEqual([
        { country: 'COG', currency: 'XAF', balance: '21798.03' },
        {
          country: 'COG',
          currency: 'XAF',
          balance: '10.00',
          operator: 'MTN_MOMO_COG',
        },
      ]);
    });

    it('throws when pawaPay refuses, so the caller can say so', async () => {
      fetchMock.mockResolvedValue(reply(401, { errorCode: 'AUTH' }));
      await expect(gateway.getBalances('COG')).rejects.toThrow(/HTTP 401/);
    });

    it('lists the account countries from the active configuration, cached', async () => {
      fetchMock.mockResolvedValue(
        reply(200, {
          countries: [
            { country: 'CMR', displayName: { en: 'Cameroon', fr: 'Cameroun' } },
            { country: 'COG', displayName: { en: 'Congo' } },
          ],
        }),
      );
      const first = await gateway.listBalanceCountries();
      await gateway.listBalanceCountries();
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.sandbox.pawapay.io/v2/active-conf',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(first).toEqual([
        { code: 'CMR', name: 'Cameroun' },
        { code: 'COG', name: 'Congo' },
      ]);
    });
  });
});

describe('pawaPay helpers', () => {
  it.each([
    ['06 123 45 67', 'COG', '242061234567'],
    ['+242 06 123 45 67', 'COG', '242061234567'],
    ['00242061234567', 'COG', '242061234567'],
    ['677 12 34 56', 'CMR', '237677123456'],
  ])('puts %s in MSISDN form for %s', (phone, country, msisdn) => {
    expect(toMsisdn(phone, country)).toBe(msisdn);
  });

  it('omits the email when there is none, and never sends more than 10 fields', () => {
    const items = buildDepositMetadata(
      { ...deposit, payer: { ...deposit.payer, email: null } },
      '242061234567',
    );
    expect(items.some((i) => 'payerEmail' in i)).toBe(false);
    expect(items.length).toBeLessThanOrEqual(10);
  });

  it.each([
    ['CONTACT_UNLOCK', 'Rabotka contact'],
    ['WALLET_TOP_UP', 'Rabotka recharge'],
    ['PENALTY_BATCH', 'Rabotka penalite'],
    [null, 'Rabotka paiement'],
  ])('writes a receipt narration pawaPay accepts for %s', (type, message) => {
    const out = customerMessageFor(type);
    expect(out).toBe(message);
    expect(out).toMatch(/^[a-zA-Z0-9 ]{4,22}$/);
  });
});
