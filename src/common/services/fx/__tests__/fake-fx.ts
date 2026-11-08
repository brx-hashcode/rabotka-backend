import type { ExchangeRateService, FxRate } from '../exchange-rate.service';
import { isCfa, toLocalAmount } from '../local-price';

export const DEFAULT_FX_RULES = {
  maxAgeHours: 72,
  significantDigits: 2,
  marginPercent: 0,
  preferredCurrencies: ['USD'],
};

/**
 * An ExchangeRateService for specs: the CFA francs at 1, and only the rates
 * given (units per XAF), all fresh, rounded with the default rules.
 */
export function fakeFx(
  rates: Record<string, number> = {},
): Pick<ExchangeRateService, 'freshRates' | 'rate' | 'quote' | 'refresh'> {
  const asOf = new Date('2026-11-07T00:00:00Z');
  const fresh = new Map<string, FxRate>(
    Object.entries(rates).map(([c, perXaf]) => [c, { perXaf, asOf }]),
  );
  const rate = (currency: string): FxRate | null =>
    isCfa(currency) ? { perXaf: 1, asOf } : (fresh.get(currency) ?? null);
  return {
    freshRates: jest.fn(() => Promise.resolve(fresh)),
    rate: jest.fn((currency: string) => Promise.resolve(rate(currency))),
    quote: jest.fn((xaf: number, currency: string, decimals: number) => {
      const r = rate(currency);
      return Promise.resolve(
        r
          ? {
              currency,
              amount: toLocalAmount(xaf, currency, r.perXaf, {
                decimals,
                significantDigits: DEFAULT_FX_RULES.significantDigits,
                marginPercent: DEFAULT_FX_RULES.marginPercent,
              }),
              perXaf: r.perXaf,
              asOf: r.asOf,
            }
          : null,
      );
    }),
    refresh: jest.fn(() => Promise.resolve(null)),
  };
}
