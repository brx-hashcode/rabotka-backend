import { fetchWithTimeout } from '../../utils/fetch-with-timeout.util';

/**
 * Where the day's rates against XAF come from.
 *
 * The ECB feed the WhatsApp card uses (currency-conversion.util.ts) quotes
 * none of the currencies pawaPay charges in outside the CFA zone — no CDF,
 * KES, NGN, UGX, RWF, ZMW… — so these two free, keyless feeds are used
 * instead, the second only when the first fails. Both quote XAF directly.
 *
 * A feed is trusted only if it agrees with the treaty: XOF must come back at
 * 1 per XAF. A feed that gets the one fixed rate wrong is not trusted for the
 * floating ones either.
 */
export type FxSnapshot = {
  /** Units of each currency for 1 XAF, upper-case codes. */
  rates: Record<string, number>;
  asOf: Date;
  source: string;
};

type Fetcher = () => Promise<FxSnapshot | null>;

const OPEN_ER_API = 'https://open.er-api.com/v6/latest/XAF';
const CURRENCY_API = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xaf.min.json',
  'https://latest.currency-api.pages.dev/v1/currencies/xaf.min.json',
];

/** Positive, finite numbers only, keyed in upper case. */
export function cleanRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [code, value] of Object.entries(raw)) {
    if (!/^[a-z]{3}$/i.test(code)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      continue;
    out[code.toUpperCase()] = value;
  }
  return out;
}

/** The treaty canary: XOF at 1 per XAF, within a rounding hair. */
export function agreesWithPeg(rates: Record<string, number>): boolean {
  const xof = rates['XOF'];
  return xof !== undefined && Math.abs(xof - 1) < 0.005;
}

export function parseOpenErApi(body: unknown): FxSnapshot | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b['result'] !== 'success') return null;
  const rates = cleanRates(b['rates']);
  const unix = Number(b['time_last_update_unix']);
  if (!agreesWithPeg(rates) || !Number.isFinite(unix)) return null;
  return {
    rates,
    asOf: new Date(unix * 1000),
    source: 'open.er-api.com',
  };
}

export function parseCurrencyApi(body: unknown): FxSnapshot | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const rates = cleanRates(b['xaf']);
  const date = typeof b['date'] === 'string' ? new Date(b['date']) : null;
  if (!agreesWithPeg(rates) || !date || Number.isNaN(date.getTime()))
    return null;
  return { rates, asOf: date, source: 'currency-api (fawazahmed0)' };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const FETCHERS: Fetcher[] = [
  async () => parseOpenErApi(await getJson(OPEN_ER_API)),
  ...CURRENCY_API.map(
    (url): Fetcher =>
      async () =>
        parseCurrencyApi(await getJson(url)),
  ),
];

/**
 * The first feed that answers sensibly, or null. Never a hard-coded rate: a
 * currency with no rate is not offered, which is visible; a stale constant
 * would quietly charge the wrong price.
 */
export async function fetchFxSnapshot(
  fetchers: Fetcher[] = FETCHERS,
  onError?: (err: unknown) => void,
): Promise<FxSnapshot | null> {
  for (const fetcher of fetchers) {
    try {
      const snapshot = await fetcher();
      if (snapshot) return snapshot;
    } catch (err) {
      onError?.(err);
    }
  }
  return null;
}
