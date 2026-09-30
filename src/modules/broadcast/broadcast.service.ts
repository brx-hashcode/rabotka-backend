import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BroadcastRecipientStatus,
  BroadcastStatus,
  DeliveryChannel,
  Prisma,
  type Broadcast,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { BROADCAST_QUEUE } from '../../common/services/queue/queue.module';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  buildAudienceWhere,
  type AudienceFilters,
  type AudiencePreview,
} from './audience';
import type { BroadcastJobData } from './broadcast.types';

/** How many recipient rows are written per insert. */
const SNAPSHOT_BATCH = 1_000;

/** How many recipients one queue job handles. */
export const CHUNK_SIZE = 200;

/**
 * A broadcast may not exceed this many recipients.
 *
 * Not a technical limit — the fan-out is chunked and would happily do more. It
 * is a blast radius: every WhatsApp recipient outside the 24h window is a paid
 * MARKETING template, and a mistyped filter that widens a segment from 200 to
 * 20 000 should fail loudly rather than bill quietly. Raise it deliberately.
 */
export const MAX_RECIPIENTS = 5_000;

/** Statuses a draft may still be edited or deleted in. */
const EDITABLE: BroadcastStatus[] = [
  BroadcastStatus.DRAFT,
  BroadcastStatus.SCHEDULED,
];

/** One point of the delivery curve: cumulative deliveries per channel. */
export type BroadcastTimelinePoint = {
  /** ISO minute the bucket starts at. */
  at: string;
} & Partial<Record<Exclude<DeliveryChannel, 'ALL'>, number>>;

export type BroadcastStats = {
  byChannel: {
    channel: DeliveryChannel;
    status: BroadcastRecipientStatus;
    count: number;
  }[];
  timeline: BroadcastTimelinePoint[];
};

export type CreateBroadcastInput = {
  title: string;
  body: string;
  link?: string;
  channels: DeliveryChannel[];
  audience: AudienceFilters;
  createdById?: string;
};

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * How many people a set of filters reaches, and how many of them for free.
   *
   * Counts only — no rows are materialised. It is called on every keystroke of
   * the audience builder (debounced), so it must stay cheap: five `count`s and
   * one five-row sample, all on indexed columns.
   *
   * The free/billable split is the whole reason the admin sees a cost before
   * confirming, and it is only computable because `Profile.last_inbound_at`
   * exists — see the dispatcher work that introduced it.
   */
  async preview(filters: AudienceFilters): Promise<AudiencePreview> {
    const where = buildAudienceWhere(filters);

    const windowOpensAfter = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total, whatsapp, email, freeWhatsapp, sample] = await Promise.all([
      this.prisma.profile.count({ where }),
      this.prisma.profile.count({
        where: { AND: [where, { whatsapp_connected: true }] },
      }),
      this.prisma.profile.count({
        where: { AND: [where, { email: { not: null } }] },
      }),
      this.prisma.profile.count({
        where: {
          AND: [
            where,
            { whatsapp_connected: true },
            { last_inbound_at: { gt: windowOpensAfter } },
          ],
        },
      }),
      this.prisma.profile.findMany({
        where,
        select: { id: true, first_name: true, last_name: true, city: true },
        orderBy: { created_at: 'desc' },
        take: 5,
      }),
    ]);

    return {
      total,
      // In-app reaches everyone in the audience: it needs no phone and no
      // address, only an account.
      reachable: { IN_APP: total, WHATSAPP: whatsapp, EMAIL: email },
      freeWhatsapp,
      billableWhatsapp: whatsapp - freeWhatsapp,
      sample: sample.map((p) => ({
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        city: p.city,
      })),
    };
  }

  /**
   * How many people each trade would actually reach.
   *
   * The trade list is the platform's full taxonomy, but most profiles carry no
   * category at all — so an admin ticking a trade at random lands on an empty
   * audience and reads it as a broken filter. Counting first turns the list
   * from "every trade that exists" into "every trade someone is in".
   *
   * Faceted: the count for each trade is computed with the OTHER filters
   * applied but the trade filter removed, which is what makes the numbers
   * stay true as you tick them — otherwise selecting one trade would drop
   * every other count to zero.
   */
  async categoryFacets(
    filters: AudienceFilters,
  ): Promise<{ categoryId: string; count: number }[]> {
    const { category_ids: _ignored, ...rest } = filters;
    const audience = buildAudienceWhere(rest);

    // Counted from BOTH places a trade lives, then merged. The join table is
    // where the trades people pick in the app actually go; the scalar column
    // is the headline one and is usually empty. Counting only the column
    // reported 0 beside trades that plainly had members.
    const [fromRelation, fromColumn] = await Promise.all([
      this.prisma.profileCategory.groupBy({
        by: ['category_id'],
        where: { profile: audience },
        _count: { _all: true },
      }),
      this.prisma.profile.groupBy({
        by: ['category_id'],
        where: { AND: [audience, { category_id: { not: null } }] },
        _count: { _all: true },
      }),
    ]);

    // A profile whose headline trade is also in its list must not be counted
    // twice, so the two sources are merged by taking the LARGER count rather
    // than the sum — the relation is a superset in practice, and over-counting
    // an audience is the one direction that misleads a send.
    const merged = new Map<string, number>();
    for (const row of fromRelation) {
      merged.set(row.category_id, row._count._all);
    }
    for (const row of fromColumn) {
      if (!row.category_id) continue;
      merged.set(
        row.category_id,
        Math.max(merged.get(row.category_id) ?? 0, row._count._all),
      );
    }

    return [...merged.entries()]
      .map(([categoryId, count]) => ({ categoryId, count }))
      .sort((a, b) => b.count - a.count);
  }

  async create(input: CreateBroadcastInput): Promise<Broadcast> {
    this.assertChannels(input.channels);

    return this.prisma.broadcast.create({
      data: {
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        channels: input.channels,
        audience: input.audience,
        ...(input.createdById ? { created_by_id: input.createdById } : {}),
      },
    });
  }

  async update(
    id: string,
    input: Partial<CreateBroadcastInput>,
  ): Promise<Broadcast> {
    const broadcast = await this.getOrThrow(id);
    if (!EDITABLE.includes(broadcast.status)) {
      throw new BadRequestException(
        'Seul un brouillon ou un envoi programmé peut être modifié',
      );
    }
    if (input.channels) this.assertChannels(input.channels);

    return this.prisma.broadcast.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.link !== undefined ? { link: input.link } : {}),
        ...(input.channels ? { channels: input.channels } : {}),
        ...(input.audience ? { audience: input.audience } : {}),
      },
    });
  }

  async remove(id: string): Promise<void> {
    const broadcast = await this.getOrThrow(id);
    if (!EDITABLE.includes(broadcast.status)) {
      throw new BadRequestException(
        'Un envoi déjà parti ne peut pas être supprimé',
      );
    }
    await this.prisma.broadcast.delete({ where: { id } });
  }

  async list(params: {
    page: number;
    limit: number;
    status?: BroadcastStatus[];
  }): Promise<{
    data: Broadcast[];
    total: number;
    page: number;
    limit: number;
  }> {
    const where: Prisma.BroadcastWhereInput = params.status?.length
      ? { status: { in: params.status } }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.broadcast.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.broadcast.count({ where }),
    ]);

    return { data, total, page: params.page, limit: params.limit };
  }

  async getOrThrow(id: string): Promise<Broadcast> {
    const broadcast = await this.prisma.broadcast.findUnique({ where: { id } });
    if (!broadcast) throw new NotFoundException('Envoi introuvable');
    return broadcast;
  }

  async listRecipients(
    id: string,
    params: { page: number; limit: number; channel?: DeliveryChannel },
  ) {
    const where: Prisma.BroadcastRecipientWhereInput = {
      broadcast_id: id,
      ...(params.channel ? { channel: params.channel } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.broadcastRecipient.findMany({
        where,
        include: {
          profile: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
            },
          },
        },
        orderBy: { created_at: 'asc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.broadcastRecipient.count({ where }),
    ]);

    return { data, total, page: params.page, limit: params.limit };
  }

  /**
   * Delivery broken down by channel, and how it accumulated over time.
   *
   * One `groupBy` for the totals and one bucketed query for the curve, rather
   * than a page of recipients: the detail page charts every row, and the list
   * it sits above is paginated at 50.
   *
   * The timeline is CUMULATIVE and computed here, not in the browser. A chart
   * that has to fold running totals itself is a chart that disagrees with the
   * counters the moment a page is re-fetched mid-send.
   */
  async stats(id: string): Promise<BroadcastStats> {
    await this.getOrThrow(id);

    const [totals, buckets] = await Promise.all([
      this.prisma.broadcastRecipient.groupBy({
        by: ['channel', 'status'],
        where: { broadcast_id: id },
        _count: { _all: true },
      }),
      // Raw, because `groupBy` cannot bucket a timestamp. By the minute: the
      // fan-out paces WhatsApp at ~8 messages a second, so a second-level
      // bucket would be mostly empty and a hourly one mostly flat.
      this.prisma.$queryRaw<
        { bucket: Date; channel: DeliveryChannel; count: number }[]
      >`
        SELECT date_trunc('minute', sent_at) AS bucket,
               channel,
               count(*)::int AS count
        FROM broadcast_recipients
        WHERE broadcast_id = ${id}::uuid
          AND sent_at IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `,
    ]);

    return {
      byChannel: totals.map((row) => ({
        channel: row.channel,
        status: row.status,
        count: row._count._all,
      })),
      timeline: toCumulative(buckets),
    };
  }

  /**
   * Freeze the audience, then hand the chunks to the queue.
   *
   * The snapshot is the point. Filters are evaluated ONCE, here, and written to
   * `broadcast_recipients`; everything downstream works from those rows. So a
   * profile that stops matching mid-send still receives the message it was
   * selected for, a retried chunk cannot double-send (the unique constraint
   * says so), and the report afterwards describes what was actually attempted
   * rather than what the filters would match today.
   */
  async send(
    id: string,
    opts: { scheduledAt?: Date } = {},
  ): Promise<{ recipientCount: number; estimatedCost: number }> {
    const broadcast = await this.getOrThrow(id);
    // A scheduled broadcast already has a delayed job waiting, and that job
    // only looks at the status when it fires. Sending again would leave two of
    // them, and the first would go out at the OLD time. Cancel, then start over.
    if (broadcast.status === BroadcastStatus.SCHEDULED) {
      throw new BadRequestException(
        'Cet envoi est déjà programmé — annulez-le pour en programmer un autre',
      );
    }
    if (!EDITABLE.includes(broadcast.status)) {
      throw new BadRequestException('Cet envoi est déjà parti');
    }
    // Without this a past time is sent at once while the row says SCHEDULED,
    // which reads as a schedule that was honoured.
    if (opts.scheduledAt && opts.scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('L’heure programmée est déjà passée');
    }

    const filters = broadcast.audience as unknown as AudienceFilters;
    const preview = await this.preview(filters);

    if (preview.total === 0) {
      throw new BadRequestException(
        'Cette audience ne correspond à personne — ajustez les filtres',
      );
    }
    if (preview.total > MAX_RECIPIENTS) {
      throw new BadRequestException(
        `Cette audience compte ${preview.total} personnes, au-delà de la limite ` +
          `de ${MAX_RECIPIENTS} par envoi. Restreignez les filtres.`,
      );
    }

    const estimatedCost = await this.estimateCost(
      broadcast.channels,
      preview.billableWhatsapp,
    );

    const recipientCount = await this.snapshotAudience(broadcast, filters);

    await this.prisma.broadcast.update({
      where: { id },
      data: {
        status: opts.scheduledAt
          ? BroadcastStatus.SCHEDULED
          : BroadcastStatus.SENDING,
        scheduled_at: opts.scheduledAt ?? null,
        recipient_count: recipientCount,
        estimated_cost: estimatedCost,
      },
    });

    const runId = randomUUID();
    await this.queueService.addJob<BroadcastJobData>(
      BROADCAST_QUEUE,
      { type: 'dispatch', broadcastId: id, cursor: 0, runId },
      {
        jobId: `broadcast-${id}-${runId}`,
        ...(opts.scheduledAt
          ? { delay: Math.max(0, opts.scheduledAt.getTime() - Date.now()) }
          : {}),
      },
    );

    this.logger.log(
      `Broadcast ${id} queued for ${recipientCount} recipient row(s), ` +
        `estimated ${estimatedCost} FCFA`,
    );

    return { recipientCount, estimatedCost };
  }

  /**
   * Send again, to the recipients that failed and only them.
   *
   * The failed rows go back to PENDING and the fan-out is re-queued; the
   * processor already picks PENDING rows and sends each on the channel its own
   * row names, so a WhatsApp failure retries on WhatsApp and an email failure
   * on email, with no notion of "the broadcast's channel" involved.
   *
   * Nothing that succeeded is touched. That is the whole point of keeping a row
   * per delivery rather than a counter: a retry after a template was finally
   * approved must not message the people who already received it.
   *
   * Counters are recomputed from the rows rather than adjusted, so a retry can
   * be run twice without the totals drifting.
   */
  async retryFailed(id: string): Promise<{ retried: number }> {
    const broadcast = await this.getOrThrow(id);

    if (broadcast.status === BroadcastStatus.SENDING) {
      throw new BadRequestException(
        'Cet envoi est encore en cours — attendez qu’il se termine',
      );
    }

    const failed = await this.prisma.broadcastRecipient.count({
      where: { broadcast_id: id, status: BroadcastRecipientStatus.FAILED },
    });
    if (failed === 0) {
      throw new BadRequestException('Aucun envoi en échec à relancer');
    }

    await this.prisma.broadcastRecipient.updateMany({
      where: { broadcast_id: id, status: BroadcastRecipientStatus.FAILED },
      data: {
        status: BroadcastRecipientStatus.PENDING,
        error: null,
        sent_at: null,
      },
    });

    await this.prisma.broadcast.update({
      where: { id },
      data: {
        status: BroadcastStatus.SENDING,
        failed_count: await this.prisma.broadcastRecipient.count({
          where: { broadcast_id: id, status: BroadcastRecipientStatus.FAILED },
        }),
      },
    });

    // A fresh run id: the original run's job ids live for an hour in BullMQ,
    // and anything reused from them is silently dropped as a duplicate.
    const runId = randomUUID();
    await this.queueService.addJob<BroadcastJobData>(
      BROADCAST_QUEUE,
      { type: 'dispatch', broadcastId: id, cursor: 0, runId },
      { jobId: `broadcast-${id}-${runId}` },
    );

    this.logger.log(`Broadcast ${id}: retrying ${failed} failed delivery(ies)`);

    return { retried: failed };
  }

  /**
   * Stop a scheduled or in-flight broadcast.
   *
   * CANCELLED is read by the processor between chunks, so an in-flight send
   * stops at the next chunk boundary rather than mid-message. Nothing already
   * delivered is undone — WhatsApp has no such verb.
   */
  async cancel(id: string): Promise<Broadcast> {
    const broadcast = await this.getOrThrow(id);
    if (
      broadcast.status === BroadcastStatus.SENT ||
      broadcast.status === BroadcastStatus.CANCELLED
    ) {
      throw new BadRequestException('Cet envoi est déjà terminé');
    }

    await this.queueService
      .getQueue(BROADCAST_QUEUE)
      .remove(`broadcast-${id}`)
      .catch(() => undefined);

    return this.prisma.broadcast.update({
      where: { id },
      data: { status: BroadcastStatus.CANCELLED },
    });
  }

  /**
   * Write one recipient row per (profile, channel), in batches.
   *
   * `skipDuplicates` rather than a transaction: this can be re-entered after a
   * crash mid-snapshot, and the unique constraint already says what a duplicate
   * is. `ALL` is expanded here so the processor never has to interpret it.
   */
  private async snapshotAudience(
    broadcast: Broadcast,
    filters: AudienceFilters,
  ): Promise<number> {
    const channels = expandChannels(broadcast.channels);
    const where = buildAudienceWhere(filters);

    let cursor: string | undefined;
    let written = 0;

    for (;;) {
      const batch = await this.prisma.profile.findMany({
        where,
        select: { id: true },
        orderBy: { id: 'asc' },
        take: SNAPSHOT_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;

      const rows = batch.flatMap((profile) =>
        channels.map((channel) => ({
          broadcast_id: broadcast.id,
          profile_id: profile.id,
          channel,
        })),
      );

      const result = await this.prisma.broadcastRecipient.createMany({
        data: rows,
        skipDuplicates: true,
      });
      written += result.count;
      cursor = batch[batch.length - 1].id;
    }

    return written;
  }

  /**
   * What the WhatsApp leg will cost, in FCFA.
   *
   * Only the recipients whose window is CLOSED are billable — the rest receive
   * free-form text through the dispatcher. In-app and email cost nothing we
   * meter here.
   */
  private async estimateCost(
    channels: DeliveryChannel[],
    billableWhatsapp: number,
  ): Promise<number> {
    if (!expandChannels(channels).includes(DeliveryChannel.WHATSAPP)) return 0;

    const unitCost = await this.systemConfig.getMarketingTemplateCostFcfa();
    return Math.round(billableWhatsapp * unitCost);
  }

  private assertChannels(channels: DeliveryChannel[]): void {
    if (!channels.length) {
      throw new BadRequestException('Choisissez au moins un canal');
    }
  }
}

/**
 * Per-minute counts folded into a running total per channel.
 *
 * Every point carries every channel seen so far, including the ones that
 * delivered nothing in that minute — a line with holes in it reads as a
 * channel that stopped, rather than one that was simply quiet.
 */
function toCumulative(
  buckets: { bucket: Date; channel: DeliveryChannel; count: number }[],
): BroadcastTimelinePoint[] {
  const running = new Map<string, number>();
  const byBucket = new Map<string, BroadcastTimelinePoint>();

  for (const row of buckets) {
    const at = row.bucket.toISOString();
    running.set(row.channel, (running.get(row.channel) ?? 0) + row.count);

    const point = byBucket.get(at) ?? { at };
    byBucket.set(at, point);
  }

  // Second pass, so each point carries the running total of EVERY channel as
  // of that minute rather than only the ones that moved in it.
  const totals = new Map<string, number>();
  const points: BroadcastTimelinePoint[] = [];

  for (const at of [...byBucket.keys()].sort((a, b) => a.localeCompare(b))) {
    for (const row of buckets.filter((b) => b.bucket.toISOString() === at)) {
      totals.set(row.channel, (totals.get(row.channel) ?? 0) + row.count);
    }
    points.push({
      at,
      ...(Object.fromEntries(totals) as Record<string, number>),
    });
  }

  return points;
}

/**
 * `ALL` as the channels it actually means.
 *
 * The enum's `ALL` predates this module (the ads product uses it to mean "email
 * and WhatsApp"), and a broadcast must never leave it uninterpreted: a
 * recipient row carrying `ALL` would be ambiguous at send time, and ambiguity
 * on this path means either a missing message or a duplicate one.
 */
export function expandChannels(
  channels: DeliveryChannel[],
): Exclude<DeliveryChannel, 'ALL'>[] {
  const expanded = new Set<Exclude<DeliveryChannel, 'ALL'>>();

  for (const channel of channels) {
    if (channel === DeliveryChannel.ALL) {
      expanded.add(DeliveryChannel.EMAIL);
      expanded.add(DeliveryChannel.WHATSAPP);
      expanded.add(DeliveryChannel.IN_APP);
      continue;
    }
    expanded.add(channel);
  }

  return [...expanded];
}
