import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
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
    if (!EDITABLE.includes(broadcast.status)) {
      throw new BadRequestException('Cet envoi est déjà parti');
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

    await this.queueService.addJob<BroadcastJobData>(
      BROADCAST_QUEUE,
      { type: 'dispatch', broadcastId: id, cursor: 0 },
      {
        jobId: `broadcast-${id}`,
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
