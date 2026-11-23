import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';
import { fetchFxSnapshot, type FxSnapshot } from './fx-sources';
import { isCfa, toLocalAmount } from './local-price';

export type FxRate = { perXaf: number; asOf: Date };

/** An XAF price as a network will be charged it. */
export type LocalQuote = {
  currency: string;
  amount: number;
  /** Units of `currency` for 1 XAF (1 in the CFA zone). */
  perXaf: number;
  asOf: Date;
};

/** In memory between reads: rates move once a day. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * The day's exchange rates against XAF, and the local price of an XAF amount.
 *
 * Rates are read from the database (refreshed by ExchangeRateScheduler), and
 * one older than `payment.fx_max_age_hours` counts as missing: its currency
 * is then not offered, rather than charged at a rate nobody can vouch for.
 * The CFA francs never need a rate.
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private cache: { rates: Map<string, FxRate>; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /** Fetches the day's rates and stores them. Null when no feed answered. */
  async refresh(
    fetch: () => Promise<FxSnapshot | null> = () =>
      fetchFxSnapshot(undefined, (err) =>
        this.logger.warn(
          `Exchange-rate feed failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      ),
  ): Promise<{ source: string; count: number } | null> {
    const snapshot = await fetch();
    if (!snapshot) {
      this.logger.warn(
        'No exchange-rate feed answered: rates kept as they were',
      );
      return null;
    }
    const entries = Object.entries(snapshot.rates).filter(
      ([currency]) => !isCfa(currency),
    );
    // One statement for the whole feed (160-odd currencies): as a transaction
    // of upserts it outran Prisma's 5 s limit while the app was booting.
    // Rates go as text, so numeric(24,12) gets them without a float's noise.
    if (entries.length > 0) {
      await this.prisma.$executeRaw`
        INSERT INTO exchange_rates (currency, per_xaf, source, as_of, fetched_at)
        SELECT t.currency, t.per_xaf::numeric, ${snapshot.source}, ${snapshot.asOf}, now()
        FROM unnest(
          ${entries.map(([currency]) => currency)}::text[],
          ${entries.map(([, perXaf]) => String(perXaf))}::text[]
        ) AS t(currency, per_xaf)
        ON CONFLICT (currency) DO UPDATE SET
          per_xaf = EXCLUDED.per_xaf,
          source = EXCLUDED.source,
          as_of = EXCLUDED.as_of,
          fetched_at = now()`;
    }
    this.cache = null;
    return { source: snapshot.source, count: entries.length };
  }

  /** Every stored rate young enough to charge with. */
  async freshRates(now = new Date()): Promise<Map<string, FxRate>> {
    if (this.cache && now.getTime() - this.cache.at < CACHE_MS) {
      return this.cache.rates;
    }
    const { maxAgeHours } = await this.systemConfig.getFxRules();
    const since = new Date(now.getTime() - maxAgeHours * 60 * 60 * 1000);
    const rows = await this.prisma.exchangeRate.findMany({
      where: { as_of: { gte: since } },
    });
    const rates = new Map(
      rows.map((r) => [
        r.currency,
        { perXaf: Number(r.per_xaf), asOf: r.as_of },
      ]),
    );
    this.cache = { rates, at: now.getTime() };
    return rates;
  }

  /** The rate of one currency, 1 for the CFA francs, null when stale or unknown. */
  async rate(currency: string, now = new Date()): Promise<FxRate | null> {
    if (isCfa(currency)) return { perXaf: 1, asOf: now };
    return (await this.freshRates(now)).get(currency) ?? null;
  }

  /**
   * What `xaf` costs in `currency`, rounded as the admin set it and as the
   * network allows (`decimals`). Null when the currency has no fresh rate.
   */
  async quote(
    xaf: number,
    currency: string,
    decimals: number,
    now = new Date(),
  ): Promise<LocalQuote | null> {
    const rate = await this.rate(currency, now);
    if (!rate) return null;
    const { significantDigits, marginPercent } =
      await this.systemConfig.getFxRules();
    return {
      currency,
      amount: toLocalAmount(xaf, currency, rate.perXaf, {
        decimals,
        significantDigits,
        marginPercent,
      }),
      perXaf: rate.perXaf,
      asOf: rate.asOf,
    };
  }
}
