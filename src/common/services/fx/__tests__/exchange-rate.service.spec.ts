import { ExchangeRateService } from '../exchange-rate.service';
import { DEFAULT_FX_RULES } from './fake-fx';

const NOW = new Date('2026-11-07T12:00:00Z');

function setup(rows: { currency: string; per_xaf: number; as_of: Date }[]) {
  const prisma = {
    exchangeRate: {
      findMany: jest.fn(({ where }: { where: { as_of: { gte: Date } } }) =>
        Promise.resolve(rows.filter((r) => r.as_of >= where.as_of.gte)),
      ),
      upsert: jest.fn((args: unknown) => args),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
  };
  const systemConfig = {
    getFxRules: jest.fn().mockResolvedValue(DEFAULT_FX_RULES),
  };
  return {
    service: new ExchangeRateService(prisma as never, systemConfig as never),
    prisma,
  };
}

describe('ExchangeRateService', () => {
  it('prices the CFA francs at 1 without any stored rate', async () => {
    const { service } = setup([]);
    await expect(service.quote(1000, 'XOF', 0, NOW)).resolves.toMatchObject({
      amount: 1000,
      perXaf: 1,
    });
  });

  it('converts with a fresh rate', async () => {
    const { service } = setup([
      { currency: 'USD', per_xaf: 0.001701, as_of: new Date('2026-11-07') },
    ]);
    await expect(service.quote(1000, 'USD', 2, NOW)).resolves.toMatchObject({
      currency: 'USD',
      amount: 1.7,
    });
  });

  it('does not price with a rate older than the limit', async () => {
    const { service } = setup([
      { currency: 'USD', per_xaf: 0.0017, as_of: new Date('2026-11-01') },
    ]);
    await expect(service.quote(1000, 'USD', 2, NOW)).resolves.toBeNull();
  });

  it('stores a feed, leaving the CFA francs out', async () => {
    const { service, prisma } = setup([]);
    const result = await service.refresh(() =>
      Promise.resolve({
        rates: { XAF: 1, XOF: 1, USD: 0.0017, CDF: 3.97 },
        asOf: NOW,
        source: 'test',
      }),
    );
    expect(result).toEqual({ source: 'test', count: 2 });
    expect(prisma.exchangeRate.upsert).toHaveBeenCalledTimes(2);
  });

  it('keeps the stored rates when no feed answers', async () => {
    const { service, prisma } = setup([]);
    await expect(service.refresh(() => Promise.resolve(null))).resolves.toBe(
      null,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
