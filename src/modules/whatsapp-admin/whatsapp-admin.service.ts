import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MessageDirection,
  Prisma,
  WhatsappDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  fetchAedToXafRate,
  type FxQuote,
} from '../../common/utils/currency-conversion.util';
import {
  AdminCacheService,
  ADMIN_LIST_TTL_SECONDS,
  ADMIN_DASHBOARD_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  WHATSAPP_OUTBOUND_DLQ,
} from '../../common/services/queue/queue.module';
import {
  CloudAnalyticsClient,
  unavailableAnalytics,
  type CloudAnalyticsResult,
} from '../whatsapp/providers/cloud/cloud-analytics.client';
import {
  CloudBillingClient,
  type CloudBillingResult,
} from '../whatsapp/providers/cloud/cloud-billing.client';
import {
  parseWhatsappConfig,
  type WhatsappConfig,
} from '../whatsapp/whatsapp.config';

/**
 * Read model for the WhatsApp back office.
 *
 * Deliberately separate from `WhatsAppModule`: that module is on the send path
 * and is imported by half the application, and adding admin reporting queries
 * to it would drag Prisma aggregates into the worker process's dependency
 * graph for no reason.
 */

/** Cost figures older than this are not available from Meta at all. */
const META_LOOKBACK_DAYS = 365;

export interface WhatsappMessageListItem {
  id: string;
  createdAt: Date;
  provider: string;
  providerMessageId: string | null;
  direction: MessageDirection;
  toPhone: string;
  profileId: string | null;
  profileName: string | null;
  kind: string;
  templateKey: string | null;
  templateCategory: string | null;
  bodyPreview: string;
  variables: unknown;
  status: WhatsappDeliveryStatus;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  errorCode: string | null;
  errorProviderCode: number | null;
  errorMessage: string | null;
  pricingCategory: string | null;
  billable: boolean | null;
  sentByName: string | null;
}

export interface WhatsappStats {
  /** Every message in the window, by furthest state reached. */
  totals: Record<WhatsappDeliveryStatus, number>;
  total: number;
  /**
   * Rates are expressed against SENT, not against total. A message still
   * QUEUED has not failed to be delivered — it has not been sent yet — and
   * counting it in the denominator makes a healthy backlog look like a
   * delivery problem.
   */
  sent: number;
  deliveryRate: number;
  readRate: number;
  failureRate: number;
  /** Median seconds from send to delivery, over messages that got there. */
  medianDeliverySeconds: number | null;
  timeline: {
    date: string;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
  }[];
  byTemplate: {
    templateKey: string;
    category: string | null;
    total: number;
    delivered: number;
    failed: number;
  }[];
  byError: { errorCode: string; count: number; sample: string | null }[];
}

export interface WhatsappQueueSnapshot {
  outbound: Record<string, number>;
  dlq: Record<string, number>;
  dlqJobs: {
    id: string;
    originalJobId: string | null;
    error: string | null;
    failedAt: string | null;
    phone: string | null;
    type: string | null;
  }[];
}

@Injectable()
export class WhatsappAdminService {
  private readonly logger = new Logger(WhatsappAdminService.name);
  private readonly whatsappConfig: WhatsappConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
    private readonly queueService: QueueService,
  ) {
    // Parsed once, from the same validated schema the send path uses, so the
    // billing endpoint cannot drift onto different credentials than the sender.
    this.whatsappConfig = parseWhatsappConfig(process.env);
  }

  // ---------------------------------------------------------------- messages

  async listForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: WhatsappDeliveryStatus[];
    template_key?: string[];
    kind?: string[];
    direction?: MessageDirection[];
    provider?: string[];
    profile_id?: string;
    created_from?: string;
    created_to?: string;
  }): Promise<{
    data: WhatsappMessageListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.cache.wrap(
      this.cache.listKey('whatsapp-messages', params),
      ADMIN_LIST_TTL_SECONDS,
      () => this.loadList(params),
    );
  }

  private async loadList(params: {
    page: number;
    limit: number;
    q?: string;
    status?: WhatsappDeliveryStatus[];
    template_key?: string[];
    kind?: string[];
    direction?: MessageDirection[];
    provider?: string[];
    profile_id?: string;
    created_from?: string;
    created_to?: string;
  }) {
    const { page, limit } = params;
    const skip = (page - 1) * limit;
    const where = this.buildWhere(params);

    const [rows, total] = await Promise.all([
      this.prisma.whatsappMessage.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          created_at: true,
          provider: true,
          provider_message_id: true,
          direction: true,
          to_phone: true,
          profile_id: true,
          kind: true,
          template_key: true,
          template_category: true,
          body_preview: true,
          variables: true,
          status: true,
          sent_at: true,
          delivered_at: true,
          read_at: true,
          failed_at: true,
          error_code: true,
          error_provider_code: true,
          error_message: true,
          pricing_category: true,
          billable: true,
          profile: { select: { first_name: true, last_name: true } },
          sent_by: { select: { first_name: true, last_name: true } },
        },
      }),
      this.prisma.whatsappMessage.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        provider: row.provider,
        providerMessageId: row.provider_message_id,
        direction: row.direction,
        toPhone: row.to_phone,
        profileId: row.profile_id,
        profileName: fullName(row.profile),
        kind: row.kind,
        templateKey: row.template_key,
        templateCategory: row.template_category,
        bodyPreview: row.body_preview,
        variables: row.variables,
        status: row.status,
        sentAt: row.sent_at,
        deliveredAt: row.delivered_at,
        readAt: row.read_at,
        failedAt: row.failed_at,
        errorCode: row.error_code,
        errorProviderCode: row.error_provider_code,
        errorMessage: row.error_message,
        pricingCategory: row.pricing_category,
        billable: row.billable,
        sentByName: fullName(row.sent_by),
      })),
      total,
      page,
      limit,
    };
  }

  private buildWhere(params: {
    q?: string;
    status?: WhatsappDeliveryStatus[];
    template_key?: string[];
    kind?: string[];
    direction?: MessageDirection[];
    provider?: string[];
    profile_id?: string;
    created_from?: string;
    created_to?: string;
  }): Prisma.WhatsappMessageWhereInput {
    const where: Prisma.WhatsappMessageWhereInput = {};

    const search = params.q?.trim() ?? '';
    if (search.length > 0) {
      where.OR = [
        { to_phone: { contains: search, mode: 'insensitive' } },
        { body_preview: { contains: search, mode: 'insensitive' } },
        { template_key: { contains: search, mode: 'insensitive' } },
        { provider_message_id: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (params.status?.length) where.status = { in: params.status };
    if (params.template_key?.length) {
      where.template_key = { in: params.template_key };
    }
    if (params.kind?.length) where.kind = { in: params.kind };
    if (params.direction?.length) where.direction = { in: params.direction };
    if (params.provider?.length) where.provider = { in: params.provider };
    if (params.profile_id) where.profile_id = params.profile_id;

    const range = dateRange(params.created_from, params.created_to);
    if (range) where.created_at = range;

    return where;
  }

  // ------------------------------------------------------------------- stats

  async statsForAdmin(params: {
    created_from?: string;
    created_to?: string;
  }): Promise<WhatsappStats> {
    return this.cache.wrap(
      this.cache.dashboardKey('whatsapp', params),
      ADMIN_DASHBOARD_TTL_SECONDS,
      () => this.loadStats(params),
    );
  }

  private async loadStats(params: {
    created_from?: string;
    created_to?: string;
  }): Promise<WhatsappStats> {
    const range = dateRange(params.created_from, params.created_to);
    const where: Prisma.WhatsappMessageWhereInput = range
      ? { created_at: range }
      : {};

    const [byStatus, byTemplate, byError, timeline, deliveryLatency] =
      await Promise.all([
        this.prisma.whatsappMessage.groupBy({
          by: ['status'],
          where,
          _count: { status: true },
        }),
        this.groupByTemplate(where),
        this.prisma.whatsappMessage.groupBy({
          by: ['error_code'],
          where: { ...where, error_code: { not: null } },
          _count: { error_code: true },
          orderBy: { _count: { error_code: 'desc' } },
          take: 10,
        }),
        this.loadTimeline(range),
        this.medianDeliverySeconds(range),
      ]);

    const totals = emptyTotals();
    for (const row of byStatus) totals[row.status] = row._count.status;
    const total = Object.values(totals).reduce((a, b) => a + b, 0);

    // Everything that actually left the building. FAILED rows never reached
    // the provider, so they are not part of the delivery denominator; they get
    // their own rate against the whole window instead.
    const sent = totals.SENT + totals.DELIVERED + totals.READ;
    const delivered = totals.DELIVERED + totals.READ;

    const errorSamples = await this.errorSamples(
      where,
      byError.map((row) => row.error_code).filter(isString),
    );

    return {
      totals,
      total,
      sent,
      deliveryRate: rate(delivered, sent),
      readRate: rate(totals.READ, sent),
      failureRate: rate(totals.FAILED, total),
      medianDeliverySeconds: deliveryLatency,
      timeline,
      byTemplate,
      byError: byError
        .filter((row) => row.error_code !== null)
        .map((row) => ({
          errorCode: row.error_code as string,
          count: row._count.error_code,
          sample: errorSamples.get(row.error_code as string) ?? null,
        })),
    };
  }

  private async groupByTemplate(where: Prisma.WhatsappMessageWhereInput) {
    const rows = await this.prisma.whatsappMessage.groupBy({
      by: ['template_key', 'template_category', 'status'],
      where: { ...where, template_key: { not: null } },
      _count: { _all: true },
    });

    // Rolled up in memory rather than with three queries: the cardinality is
    // the template registry (29 entries) × 5 statuses, so this is at most ~145
    // rows however busy the window is.
    const byKey = new Map<string, WhatsappStats['byTemplate'][number]>();
    for (const row of rows) {
      const key = row.template_key as string;
      const entry = byKey.get(key) ?? {
        templateKey: key,
        category: row.template_category,
        total: 0,
        delivered: 0,
        failed: 0,
      };
      entry.total += row._count._all;
      if (row.status === 'DELIVERED' || row.status === 'READ') {
        entry.delivered += row._count._all;
      }
      if (row.status === 'FAILED') entry.failed += row._count._all;
      byKey.set(key, entry);
    }

    return [...byKey.values()].sort((a, b) => b.total - a.total);
  }

  /**
   * One row per day in the window, including days with no traffic.
   *
   * A `generate_series` spine rather than a `GROUP BY date`: a chart with
   * missing days silently draws a straight line across an outage, which is
   * precisely the shape a reader must be able to see. Mirrors
   * `DashboardService.getJobActivity()`.
   */
  private async loadTimeline(range: Prisma.DateTimeFilter | null) {
    const from = range?.gte ?? daysAgo(30);
    const to = range?.lte ?? new Date();

    return this.prisma.$queryRaw<
      {
        date: string;
        sent: number;
        delivered: number;
        read: number;
        failed: number;
      }[]
    >`
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        COALESCE(m.sent, 0)::int      AS sent,
        COALESCE(m.delivered, 0)::int AS delivered,
        COALESCE(m.read, 0)::int      AS read,
        COALESCE(m.failed, 0)::int    AS failed
      FROM generate_series(
        date_trunc('day', ${from}::timestamptz),
        date_trunc('day', ${to}::timestamptz),
        '1 day'
      ) AS d(day)
      LEFT JOIN (
        SELECT
          date_trunc('day', created_at) AS day,
          COUNT(*) FILTER (WHERE status IN ('SENT','DELIVERED','READ')) AS sent,
          COUNT(*) FILTER (WHERE status IN ('DELIVERED','READ'))        AS delivered,
          COUNT(*) FILTER (WHERE status = 'READ')                       AS read,
          COUNT(*) FILTER (WHERE status = 'FAILED')                     AS failed
        FROM whatsapp_messages
        WHERE created_at >= ${from}::timestamptz
          AND created_at <= ${to}::timestamptz
        GROUP BY 1
      ) AS m ON m.day = d.day
      ORDER BY d.day ASC
    `;
  }

  /**
   * Median rather than mean: delivery latency has a long tail (a handset that
   * is off for six hours), and one such message drags an average far enough to
   * make it useless as a health signal.
   */
  private async medianDeliverySeconds(
    range: Prisma.DateTimeFilter | null,
  ): Promise<number | null> {
    const from = range?.gte ?? daysAgo(30);
    const to = range?.lte ?? new Date();

    const rows = await this.prisma.$queryRaw<{ median: number | null }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (delivered_at - sent_at))
      ) AS median
      FROM whatsapp_messages
      WHERE sent_at IS NOT NULL
        AND delivered_at IS NOT NULL
        AND created_at >= ${from}::timestamptz
        AND created_at <= ${to}::timestamptz
    `;
    const median = rows[0]?.median;
    return median === null || median === undefined ? null : Math.round(median);
  }

  /** One representative message per error code, so a code is actionable. */
  private async errorSamples(
    where: Prisma.WhatsappMessageWhereInput,
    codes: string[],
  ): Promise<Map<string, string>> {
    if (codes.length === 0) return new Map();
    const rows = await this.prisma.whatsappMessage.findMany({
      where: { ...where, error_code: { in: codes } },
      distinct: ['error_code'],
      orderBy: { created_at: 'desc' },
      select: { error_code: true, error_message: true },
    });
    return new Map(
      rows
        .filter((row) => row.error_code && row.error_message)
        .map((row) => [row.error_code as string, row.error_message as string]),
    );
  }

  // ----------------------------------------------------------------- billing

  /**
   * Meta's consumption figures, plus the business's billing state.
   *
   * Two genuinely different things, returned together because the page shows
   * them side by side and confusing them is the whole hazard: `analytics` is
   * what we USED in the window, `billing` is what has been charged and what is
   * outstanding. A usage total is not an amount owed.
   *
   * The billing half needs `business_management` on the access token. Without
   * it the call still succeeds and reports `permissionMissing`, so the panel
   * can name the scope to grant rather than showing a broken card.
   */
  async billingForAdmin(params: {
    created_from?: string;
    created_to?: string;
  }): Promise<
    CloudAnalyticsResult & {
      provider: string;
      billing: CloudBillingResult;
      fx: FxQuote | null;
    }
  > {
    if (this.whatsappConfig.provider !== 'cloud') {
      // Twilio bills through Twilio; its usage lives in the Twilio console and
      // has nothing to do with the Graph API. Saying so beats an empty chart.
      throw new ServiceUnavailableException(
        'Consumption figures are only available on the Meta Cloud provider. ' +
          `WHATSAPP_PROVIDER is currently "${this.whatsappConfig.provider}".`,
      );
    }

    const to = params.created_to ? new Date(params.created_to) : new Date();
    const from = params.created_from
      ? new Date(params.created_from)
      : daysAgo(30);

    const earliest = daysAgo(META_LOOKBACK_DAYS);
    const start = from < earliest ? earliest : from;

    const config = this.whatsappConfig;

    // The try/catch is OUTSIDE `wrap` on purpose. `wrap` only writes to the
    // cache after the loader resolves, so letting the loader throw means a
    // failure is never cached — catching inside would pin a "Graph is down"
    // result for the next 15 minutes, long after Graph came back.
    try {
      return await this.cache.wrap(
        this.cache.dashboardKey('whatsapp-billing', {
          start: start.toISOString(),
          end: to.toISOString(),
        }),
        // 15 minutes. Meta's own figures settle slowly and this is a paid,
        // rate-limited upstream — refetching it on every page render would be
        // both slower and ruder than reading a slightly stale number.
        15 * 60,
        async () => {
          const analytics = new CloudAnalyticsClient(config);
          const billing = new CloudBillingClient(config);

          // In parallel, and the billing half is allowed to fail on its own:
          // the consumption chart is useful with or without it, and a
          // business-node outage should not blank the page. The FX lookup gets
          // the same treatment for the same reason — it already returns null
          // rather than throwing, so this is belt and braces.
          const [result, billingResult, fxQuote] = await Promise.all([
            analytics.fetch({ start, end: to }),
            billing.fetch().catch((err: unknown) => {
              this.logger.warn(
                `WhatsApp billing lookup failed, showing consumption only: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
              return {
                businessId: null,
                permissionMissing: null,
                creditLines: [],
                invoices: [],
                cards: [],
              } satisfies CloudBillingResult;
            }),
            fetchAedToXafRate().catch(() => null),
          ]);

          return {
            ...result,
            provider: 'cloud',
            billing: billingResult,
            // Only when Meta actually billed in dirhams. If this account is
            // ever moved to another currency the card disappears, rather than
            // labelling one currency's total as another's — which no reader
            // could catch, since both are just a number on a card.
            fx: result.currency === 'AED' ? fxQuote : null,
          };
        },
      );
    } catch (err) {
      // Graph was unreachable or refused us. Reported as DATA, not as a 500:
      // the tab also holds delivery statistics that come from our own database
      // and are perfectly fine, and taking the whole page down over a network
      // blip at Meta is out of all proportion to the problem.
      const detail = err instanceof Error ? err.message : String(err);
      this.logger.warn(`WhatsApp consumption unavailable: ${detail}`);
      return {
        ...unavailableAnalytics(detail),
        provider: 'cloud',
        billing: {
          businessId: null,
          permissionMissing: null,
          creditLines: [],
          invoices: [],
          cards: [],
        },
        // Graph is down, so there is no cost to convert and no currency to
        // check it against.
        fx: null,
      };
    }
  }

  // ------------------------------------------------------------------- queue

  async queueSnapshot(): Promise<WhatsappQueueSnapshot> {
    const outboundQueue = this.queueService.getQueue(WHATSAPP_OUTBOUND_QUEUE);
    const dlqQueue = this.queueService.getQueue(WHATSAPP_OUTBOUND_DLQ);

    const [outbound, dlq, jobs] = await Promise.all([
      outboundQueue.getJobCounts(),
      dlqQueue.getJobCounts(),
      // Newest first, capped: the DLQ has never had a consumer, so it can hold
      // a lot, and this endpoint is a diagnostic rather than an archive.
      dlqQueue.getJobs(['waiting', 'active', 'delayed', 'completed'], 0, 49),
    ]);

    return {
      outbound,
      dlq,
      dlqJobs: jobs.filter(Boolean).map((job) => {
        const data = (job.data ?? {}) as Record<string, unknown>;
        const payload = (data.data ?? {}) as Record<string, unknown>;
        return {
          id: String(job.id ?? ''),
          originalJobId: asString(data.originalJobId),
          error: asString(data.error),
          failedAt: asString(data.failedAt),
          phone: asString(payload.phone),
          type: asString(payload.type),
        };
      }),
    };
  }

  /**
   * Push a dead-lettered job back onto the outbound queue.
   *
   * The original payload is re-enqueued verbatim, and the DLQ entry is removed
   * only after the re-add succeeds — losing the record of a failure while
   * failing to retry it would be the worst of both.
   */
  async retryDlqJob(jobId: string): Promise<{ retried: boolean }> {
    const dlqQueue = this.queueService.getQueue(WHATSAPP_OUTBOUND_DLQ);
    const job = await dlqQueue.getJob(jobId);
    if (!job) return { retried: false };

    const data = (job.data ?? {}) as Record<string, unknown>;
    const payload = data.data;
    if (!payload || typeof payload !== 'object') {
      this.logger.warn(`DLQ job ${jobId} has no original payload to retry`);
      return { retried: false };
    }

    await this.queueService.addJob(WHATSAPP_OUTBOUND_QUEUE, payload);
    await job.remove();
    return { retried: true };
  }
}

// ------------------------------------------------------------------- helpers

function emptyTotals(): Record<WhatsappDeliveryStatus, number> {
  return {
    QUEUED: 0,
    SENT: 0,
    DELIVERED: 0,
    READ: 0,
    FAILED: 0,
  };
}

/** Percentage, one decimal. Zero denominator is 0, not NaN. */
function rate(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | null {
  if (!from && !to) return null;
  return {
    ...(from ? { gte: new Date(from) } : {}),
    // Inclusive of the whole end day — an admin picking "17 Aug" means through
    // 23:59, not up to midnight. Matches LogService.listForAdmin.
    ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
  };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function fullName(
  person: { first_name: string | null; last_name: string | null } | null,
): string | null {
  if (!person) return null;
  const name = [person.first_name, person.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name.length > 0 ? name : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
