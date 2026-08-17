import { Logger } from '@nestjs/common';
import { fetchWithTimeout } from '../../../../common/utils/fetch-with-timeout.util';
import type { CloudProviderConfig } from '../../whatsapp.config';

/**
 * Read-only client for the WhatsApp Business Account's analytics fields.
 *
 * Separate from `CloudClient` on purpose: that one POSTs to the PHONE NUMBER's
 * `/messages` endpoint on the hot send path, this one GETs the WABA node for a
 * back-office report. They differ in endpoint, method, cadence and failure
 * tolerance — a slow report must never share a timeout budget with a send.
 *
 * ## What Meta will and will not tell us
 *
 * `pricing_analytics` returns the APPROXIMATE COST of what we consumed, per
 * day, broken down by category and country. That is CONSUMPTION — it says
 * nothing about what has already been paid, so it must never be presented as
 * an amount owed. A 30-day usage total and an outstanding balance differ by
 * everything Meta has already charged, which is most of it.
 *
 * Balance, payments and invoices live on the BUSINESS node and are handled by
 * `CloudBillingClient`, not here. They need the `business_management` scope,
 * which a WhatsApp-only system user does not carry by default.
 *
 * Cost is also suppressed entirely for WABAs billed through a Solution
 * Partner. When that is the case the response carries volume and omits cost,
 * which is why every cost field below is optional rather than defaulted to 0 —
 * "we do not know" and "zero" must not render the same way.
 */

/**
 * Longer than the 15s send budget. This is one analytical query over up to a
 * year of data, it runs from a back-office request nobody is holding a phone
 * for, and it is cached afterwards.
 */
const REQUEST_TIMEOUT_MS = 30_000;

export type AnalyticsGranularity = 'DAILY' | 'MONTHLY' | 'HALF_HOUR';

export interface PricingDataPoint {
  start: number;
  end: number;
  volume: number;
  /** Absent for partner-billed WABAs. Never coerce to 0. */
  cost?: number;
  pricing_category?: string;
  pricing_type?: string;
  country?: string;
}

export interface MessagingDataPoint {
  start: number;
  end: number;
  sent: number;
  delivered: number;
}

export interface CloudAnalyticsResult {
  /** ISO currency of every `cost` below, as configured on the WABA. */
  currency: string | null;
  pricing: PricingDataPoint[];
  messaging: MessagingDataPoint[];
  /**
   * Why cost is missing, when it is. Surfaced to the UI so an empty chart
   * reads as an explained limitation rather than a broken integration.
   */
  costUnavailableReason: string | null;
}

export class CloudAnalyticsClient {
  private readonly logger = new Logger('WhatsAppCloudAnalytics');
  private readonly wabaUrl: string;

  constructor(private readonly config: CloudProviderConfig) {
    this.wabaUrl = `https://graph.facebook.com/${config.apiVersion}/${config.wabaId}`;
  }

  /**
   * Consumption and cost for a window.
   *
   * `start`/`end` are UNIX SECONDS — Meta rejects milliseconds silently by
   * returning an empty series rather than an error, which is a miserable thing
   * to debug, so the conversion happens here and not at the call site.
   */
  async fetch(params: {
    start: Date;
    end: Date;
    granularity?: AnalyticsGranularity;
  }): Promise<CloudAnalyticsResult> {
    const start = Math.floor(params.start.getTime() / 1000);
    const end = Math.floor(params.end.getTime() / 1000);
    const granularity = params.granularity ?? 'DAILY';

    // One request for both fields. Two round trips to the same node for data
    // that is always rendered together would double the latency for nothing.
    const fields = [
      `pricing_analytics.start(${start}).end(${end})` +
        `.granularity(${granularity})` +
        `.metric_types(['COST','VOLUME'])` +
        `.dimensions(['PRICING_CATEGORY','PRICING_TYPE','COUNTRY'])`,
      // `analytics` uses DAY/MONTH where pricing uses DAILY/MONTHLY. Same idea,
      // different vocabulary, and mixing them up yields an empty series.
      `analytics.start(${start}).end(${end})` +
        `.granularity(${granularity === 'DAILY' ? 'DAY' : 'MONTH'})`,
      'currency',
    ].join(',');

    const raw = await this.get(fields);

    const pricing = readPricingPoints(raw);
    const messaging = readMessagingPoints(raw);
    const currency = typeof raw.currency === 'string' ? raw.currency : null;

    const anyCost = pricing.some((p) => p.cost !== undefined);
    const costUnavailableReason =
      pricing.length > 0 && !anyCost
        ? 'Meta returned volume without cost for this WhatsApp Business Account. ' +
          'This is what happens when the account is billed through a Solution ' +
          'Partner rather than directly — ask the partner for charges.'
        : null;

    return { currency, pricing, messaging, costUnavailableReason };
  }

  private async get(fields: string): Promise<Record<string, unknown>> {
    const url = `${this.wabaUrl}?fields=${encodeURIComponent(fields)}`;

    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          headers: {
            // Never logged. A leaked system-user token is a full WABA takeover.
            Authorization: `Bearer ${this.config.accessToken}`,
          },
        },
        REQUEST_TIMEOUT_MS,
      );
    } catch (err) {
      const detail =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
          : `could not reach graph.facebook.com: ${reason(err)}`;
      this.logger.error(`[CloudAnalytics] ${detail}`);
      throw new Error(`WhatsApp analytics ${detail}`);
    }

    const raw: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      // The message is surfaced to an admin, so it has to say what to DO. The
      // two failures worth separating are a token that cannot read insights
      // (a permissions fix) and everything else.
      const message = readGraphError(raw) ?? response.statusText;
      this.logger.error(`[CloudAnalytics] ${response.status}: ${message}`);
      throw new Error(`WhatsApp analytics request failed: ${message}`);
    }

    return isRecord(raw) ? raw : {};
  }
}

function readPricingPoints(raw: Record<string, unknown>): PricingDataPoint[] {
  const points = readDataPoints(raw.pricing_analytics);
  return points.map((point) => ({
    start: num(point.start) ?? 0,
    end: num(point.end) ?? 0,
    volume: num(point.volume) ?? 0,
    // `undefined`, not 0 — see the class comment. A partner-billed account
    // reports real volume with no cost, and charting that as free would be a
    // lie the reader cannot detect.
    cost: num(point.cost),
    pricing_category: str(point.pricing_category),
    pricing_type: str(point.pricing_type),
    country: str(point.country),
  }));
}

function readMessagingPoints(
  raw: Record<string, unknown>,
): MessagingDataPoint[] {
  const points = readDataPoints(raw.analytics);
  return points.map((point) => ({
    start: num(point.start) ?? 0,
    end: num(point.end) ?? 0,
    sent: num(point.sent) ?? 0,
    delivered: num(point.delivered) ?? 0,
  }));
}

/**
 * Both fields wrap their series as `{ data: [{ data_points: [...] }] }`.
 *
 * Tolerant by design: Meta reshapes analytics payloads between API versions,
 * and a report that renders empty is a far better failure than one that throws
 * on an unexpected key.
 */
function readDataPoints(field: unknown): Record<string, unknown>[] {
  if (!isRecord(field)) return [];
  const data = field.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const points = entry.data_points;
    return Array.isArray(points) ? points.filter(isRecord) : [];
  });
}

function readGraphError(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const error = raw.error;
  if (!isRecord(error)) return null;
  return typeof error.message === 'string' ? error.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
