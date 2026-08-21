import { fetchWithTimeout } from './fetch-with-timeout.util';

/**
 * AED → XAF, for the WhatsApp consumption card.
 *
 * Meta bills this WABA in dirhams. Rabotka's readers reason in CFA francs, so
 * the consumption tab shows both — and this is where the second number comes
 * from.
 *
 * THERE IS NO GOOGLE CURRENCY API to call here. Google ships FX only inside
 * specific products (`convertRegionPrices` in the Play Developer API, published
 * SKU rates in Cloud Billing); neither is a general-purpose conversion endpoint,
 * and the "Google Currency Converter API" described in blog posts is not a real
 * Google product. The European Central Bank is the closest thing to an official
 * source that actually exists for this pair.
 *
 * ONLY ONE NUMBER IS FETCHED, because only one of the three legs floats:
 *
 *   XAF per EUR  655.957   fixed by treaty, guaranteed by the French Treasury
 *   AED per USD  3.6725    CBUAE peg, unchanged since 1997
 *   EUR per USD  ~1.17     the only leg that moves
 *
 *   XAF per AED = 655.957 / (EUR_USD × 3.6725)
 *
 * Deriving it this way rather than asking an aggregator for an AED→XAF quote is
 * not fussiness: free aggregators derive XAF from sparse market data and drift
 * from the peg, and the peg is the legally correct value. It also happens to be
 * the only route available through the ECB, whose reference list covers 30
 * currencies and includes NEITHER AED nor XAF — only the USD leg is quoted.
 */

/**
 * Central Bank of the UAE peg. Unchanged since 1997.
 *
 * If the UAE ever unpegs, this file keeps returning a confident wrong number
 * with nothing to signal it. Same for the CFA peg below, which has been the
 * subject of reform talk for years. Neither is likely; both would be silent.
 */
export const AED_PER_USD = 3.6725;

/** CEMAC peg, exact. €1 = 655.957 XAF by treaty, not by market. */
export const XAF_PER_EUR = 655.957;

/**
 * ECB reference rates, keyless, one call.
 *
 * `api.frankfurter.app` permanently redirects here, and the query params are
 * `from`/`to` rather than the `base`/`symbols` the older docs show — both
 * confirmed against the live endpoint.
 */
const ECB_RATE_URL = 'https://api.frankfurter.dev/v1/latest?from=EUR&to=USD';

export interface FxQuote {
  base: 'AED';
  target: 'XAF';
  /** XAF per 1 AED. */
  rate: number;
  /** The floating leg, surfaced so the figure can be audited by hand. */
  eurUsd: number;
  /** ECB reference date, straight from the response. */
  asOf: string;
  source: string;
}

/** XAF per 1 AED, given the day's EUR/USD. Pure, so the math is testable alone. */
export function aedToXafRate(eurUsd: number): number {
  return XAF_PER_EUR / (eurUsd * AED_PER_USD);
}

function readEurUsd(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const rates = (body as { rates?: unknown }).rates;
  if (typeof rates !== 'object' || rates === null) return null;
  const usd = (rates as { USD?: unknown }).USD;
  // Number.isFinite rejects NaN and both infinities; the sign and zero checks
  // are what stop a division from producing Infinity further down.
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0
    ? usd
    : null;
}

function readAsOf(body: unknown): string {
  const date =
    typeof body === 'object' && body !== null
      ? (body as { date?: unknown }).date
      : null;
  // ECB publishes once per working day, so a Sunday reading is Friday's rate.
  // The card says which day it is showing rather than implying "now".
  return typeof date === 'string' && date ? date : 'unknown date';
}

/**
 * The day's AED→XAF rate, or `null` when it could not be established.
 *
 * NEVER falls back to a hardcoded rate. A money figure the reader cannot detect
 * as wrong is worse than a visibly absent one — the caller renders "rate
 * unavailable", which is honest, where a stale constant would not be.
 */
export async function fetchAedToXafRate(): Promise<FxQuote | null> {
  try {
    const response = await fetchWithTimeout(ECB_RATE_URL);
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const eurUsd = readEurUsd(body);
    if (eurUsd === null) return null;

    return {
      base: 'AED',
      target: 'XAF',
      rate: aedToXafRate(eurUsd),
      eurUsd,
      asOf: readAsOf(body),
      source: 'ECB via frankfurter.dev',
    };
  } catch {
    // Unreachable, timed out, or not JSON. The consumption tab is useful
    // without this card and must not fail over it.
    return null;
  }
}
