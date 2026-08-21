import { WhatsappAdminService } from '../whatsapp-admin.service';
import { CloudAnalyticsClient } from '../../whatsapp/providers/cloud/cloud-analytics.client';
import { CloudBillingClient } from '../../whatsapp/providers/cloud/cloud-billing.client';
import { fetchAedToXafRate } from '../../../common/utils/currency-conversion.util';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { AdminCacheService } from '../../../common/services/cache/admin-cache.service';
import type { QueueService } from '../../../common/services/queue/queue.service';

jest.mock('../../whatsapp/providers/cloud/cloud-analytics.client');
jest.mock('../../whatsapp/providers/cloud/cloud-billing.client');
jest.mock('../../../common/utils/currency-conversion.util');

/**
 * Just the FX half of `billingForAdmin`.
 *
 * The conversion card is the one place on this page where two currencies meet,
 * so the branch that decides whether to attach a rate at all is worth pinning:
 * getting it wrong labels a dirham total as francs, and a number on a card
 * carries nothing that would let a reader notice.
 */

const analyticsResult = (currency: string | null) => ({
  currency,
  pricing: [{ start: 1, end: 2, volume: 10, cost: 24.9 }],
});

const QUOTE = {
  base: 'AED' as const,
  target: 'XAF' as const,
  rate: 152.9,
  eurUsd: 1.1681,
  asOf: '2026-08-20',
  source: 'ECB via frankfurter.dev',
};

const EMPTY_BILLING = {
  businessId: null,
  permissionMissing: null,
  creditLines: [],
  invoices: [],
  cards: [],
};

/**
 * The service parses the real WhatsApp config in its constructor, from the same
 * validated schema the send path uses, so it refuses to exist without a full
 * set of cloud credentials. These are placeholders — every Graph client that
 * would use them is mocked out above.
 */
const CLOUD_ENV = {
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'test-token',
  WHATSAPP_CLOUD_APP_SECRET: 'test-secret',
  WHATSAPP_CLOUD_VERIFY_TOKEN: 'test-verify',
  WHATSAPP_CLOUD_WABA_ID: '9876543210',
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, ...CLOUD_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function makeService() {
  const prisma = {} as PrismaService;
  // `wrap` runs the loader and returns it — the caching itself is the cache
  // service's business and is tested there.
  const cache = {
    wrap: jest.fn(
      (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader(),
    ),
    dashboardKey: jest.fn(() => 'key'),
  } as unknown as AdminCacheService;
  const queueService = {} as QueueService;

  return new WhatsappAdminService(prisma, cache, queueService);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(CloudBillingClient).mockImplementation(
    () =>
      ({
        fetch: () => Promise.resolve(EMPTY_BILLING),
      }) as unknown as CloudBillingClient,
  );
});

function withAnalytics(currency: string | null) {
  jest.mocked(CloudAnalyticsClient).mockImplementation(
    () =>
      ({
        fetch: () => Promise.resolve(analyticsResult(currency)),
      }) as unknown as CloudAnalyticsClient,
  );
}

describe('billingForAdmin FX', () => {
  it('attaches the rate when Meta billed in AED', async () => {
    withAnalytics('AED');
    jest.mocked(fetchAedToXafRate).mockResolvedValue(QUOTE);

    const result = await makeService().billingForAdmin({});

    expect(result.fx).toEqual(QUOTE);
  });

  it.each([
    ['USD', 'USD'],
    ['EUR', 'EUR'],
    ['nothing at all', null],
  ])('withholds the rate when Meta billed in %s', async (_label, currency) => {
    // The card must disappear rather than convert a non-AED total with an
    // AED→XAF rate. Nothing downstream could detect that.
    withAnalytics(currency);
    jest.mocked(fetchAedToXafRate).mockResolvedValue(QUOTE);

    const result = await makeService().billingForAdmin({});

    expect(result.fx).toBeNull();
  });

  it('still returns consumption when the rate is unavailable', async () => {
    withAnalytics('AED');
    jest.mocked(fetchAedToXafRate).mockResolvedValue(null);

    const result = await makeService().billingForAdmin({});

    expect(result.fx).toBeNull();
    expect(result.pricing).toHaveLength(1);
  });

  it('survives the FX lookup throwing outright', async () => {
    // It is documented to return null rather than throw, but the consumption
    // tab must not go down if that ever stops being true.
    withAnalytics('AED');
    jest.mocked(fetchAedToXafRate).mockRejectedValue(new Error('boom'));

    const result = await makeService().billingForAdmin({});

    expect(result.fx).toBeNull();
    expect(result.pricing).toHaveLength(1);
  });
});
