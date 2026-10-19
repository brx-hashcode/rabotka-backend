import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  AccountStatus,
  BroadcastRecipientStatus,
  DeliveryChannel,
  Prisma,
  ProfileNotificationType,
  ProfileType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { IdempotencyService } from '../../common/services/idempotency/idempotency.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ProfileNotificationsGateway } from './profile-notifications.gateway';
import { ProfileWebPushService } from './profile-web-push.service';
import {
  PROFILE_VIEWS_THRESHOLD_EVENT,
  PROFILE_VIEW_DEDUPE_SECONDS,
  profileViewDedupeKey,
  profileViewsReminderKey,
  type ProfileNotificationEventPayload,
  type ProfileViewsThresholdPayload,
} from './profile-notification.events';
import {
  renderNotification,
  type NotificationInput,
} from './notification-catalog';

export { profileViewBody } from './notification-catalog';

/**
 * What the recipient is sent. The actor appears only as a photo — never an id
 * or a name, because a profile view is anonymised (see the schema).
 */
export type ProfileNotificationDto = {
  id: string;
  type: ProfileNotificationType;
  title: string;
  body: string;
  link: string | null;
  metadata: Prisma.JsonValue;
  actorAvatarUrl: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export type AdminProfileNotificationDto = ProfileNotificationDto & {
  dismissedAt: Date | null;
  actor: {
    profileId: string;
    firstName: string;
    lastName: string;
    profileType: ProfileType;
  } | null;
};

type CreateInput = {
  recipientId: string;
  input: NotificationInput;
  actorId?: string | null;
};

const PUBLIC_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  link: true,
  metadata: true,
  created_at: true,
  read_at: true,
  // Resolved at read time so a changed photo shows on old rows too.
  actor: { select: { avatar_url: true } },
} as const satisfies Prisma.ProfileNotificationSelect;

type PublicRow = Prisma.ProfileNotificationGetPayload<{
  select: typeof PUBLIC_SELECT;
}>;

function toDto(row: PublicRow): ProfileNotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    metadata: row.metadata,
    actorAvatarUrl: row.actor?.avatar_url ?? null,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/**
 * The broadcast id an ANNOUNCEMENT's metadata carries, when it has one.
 *
 * Defensive about the shape: `metadata` is Json, and rows written before this
 * field existed simply do not have it.
 */
function broadcastIdOf(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).broadcastId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Everything but the facts that feed the copy — those are already rendered. */
function metadataOf(input: NotificationInput): Prisma.InputJsonValue {
  const { type: _type, ...rest } = input;
  return rest;
}

/** The phone notification for an in-app one: same copy, same tap target. */
function pushPayload(dto: ProfileNotificationDto) {
  return { id: dto.id, title: dto.title, body: dto.body, link: dto.link };
}

@Injectable()
export class ProfileNotificationService {
  private readonly logger = new Logger(ProfileNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly systemConfig: SystemConfigService,
    private readonly gateway: ProfileNotificationsGateway,
    private readonly events: EventEmitter2,
    private readonly push: ProfileWebPushService,
  ) {}

  /**
   * The same notification for many recipients, in one insert.
   *
   * For broadcasts: the copy is identical for everyone, so rendering it once
   * and writing the rows together turns a thousand round trips into one. The
   * socket still fires per recipient — that is a Redis publish, not a query,
   * and a bell that only updates on refresh is the bug this whole feed exists
   * to avoid.
   *
   * Returns how many rows were written. The live emit is best-effort: a
   * disconnected recipient reads it from the feed on their next open.
   */
  async createMany(
    recipientIds: string[],
    input: NotificationInput,
  ): Promise<number> {
    if (recipientIds.length === 0) return 0;

    const { title, body, link } = renderNotification(input);
    const metadata = metadataOf(input);

    const writtenAfter = new Date(Date.now() - 1_000);
    const result = await this.prisma.profileNotification.createMany({
      data: recipientIds.map((recipientId) => ({
        recipient_id: recipientId,
        type: input.type,
        title,
        body,
        link,
        metadata,
      })),
    });

    // Read the rows back rather than inventing DTOs: `createMany` returns a
    // count, and a socket payload carrying a made-up id is worse than none —
    // the client keys the feed on it.
    //
    // Costs one query per batch, and only matters in the API process: the
    // gateway holds no server in the queue worker (see `emitNew`), where a
    // broadcast actually runs. There the feed and the client's poll deliver it.
    const rows = await this.prisma.profileNotification.findMany({
      where: {
        recipient_id: { in: recipientIds },
        type: input.type,
        created_at: { gte: writtenAfter },
      },
      select: { ...PUBLIC_SELECT, recipient_id: true },
    });

    const pushes: {
      profileId: string;
      payload: ReturnType<typeof pushPayload>;
    }[] = [];
    for (const { recipient_id, ...row } of rows) {
      const dto = toDto(row);
      this.gateway.emitNew(recipient_id, dto);
      pushes.push({ profileId: recipient_id, payload: pushPayload(dto) });
    }
    // Awaited, unlike create(): a broadcast runs in the queue worker, where
    // nothing waits on it, and the job should not finish before its sends.
    await this.push.sendMany(pushes);

    return result.count;
  }

  async create({
    recipientId,
    input,
    actorId,
  }: CreateInput): Promise<ProfileNotificationDto> {
    const { title, body, link } = renderNotification(input);
    const row = await this.prisma.profileNotification.create({
      data: {
        recipient_id: recipientId,
        type: input.type,
        title,
        body,
        link,
        actor_id: actorId ?? null,
        metadata: metadataOf(input),
      },
      select: PUBLIC_SELECT,
    });
    const dto = toDto(row);
    this.gateway.emitNew(recipientId, dto);
    // Not awaited: the caller is the business event that caused this, and a
    // slow push service must not hold it up. send() never throws.
    void this.push.send(recipientId, pushPayload(dto));
    return dto;
  }

  /**
   * Handles `PROFILE_NOTIFICATION_EVENT`. Never throws — the emitter has
   * already moved on, and an unhandled rejection here would only be noise.
   */
  async handleEvent(payload: ProfileNotificationEventPayload): Promise<void> {
    const { recipientId, input, actorId, dedupeKey } = payload;
    let claimed = false;
    try {
      if (dedupeKey) {
        claimed = await this.idempotency.claim(
          dedupeKey,
          payload.dedupeTtlSeconds ?? PROFILE_VIEW_DEDUPE_SECONDS,
        );
        if (!claimed) return;
      }
      await this.create({ recipientId, input, actorId });
    } catch (err) {
      if (claimed && dedupeKey) {
        await this.idempotency.release(dedupeKey).catch(() => undefined);
      }
      this.logger.warn(
        `In-app notification ${input.type} failed for ${recipientId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Tells a worker an employer opened their profile.
   *
   * Called fire-and-forget from the detail endpoint, so it never throws: a
   * notification that failed must not fail the page the employer asked for.
   *
   * The detail endpoint is hit far more often than "an employer looked" — the
   * contact drawer and every refetch call it too — so the 24h claim per pair is
   * what turns requests into views. It is taken before the insert and handed
   * back if the insert fails, so a database hiccup does not swallow the view
   * for a day.
   */
  async notifyProfileView(employerId: string, workerId: string): Promise<void> {
    if (employerId === workerId) return;

    const dedupeKey = profileViewDedupeKey(employerId, workerId);
    let claimed = false;
    let inserted = false;
    try {
      const worker = await this.prisma.profile.findUnique({
        where: { id: workerId },
        select: { profile_type: true, status: true, deleted_at: true },
      });
      if (
        !worker ||
        worker.profile_type !== ProfileType.WORKER ||
        worker.status !== AccountStatus.ACTIVE ||
        worker.deleted_at
      ) {
        return;
      }

      claimed = await this.idempotency.claim(
        dedupeKey,
        PROFILE_VIEW_DEDUPE_SECONDS,
      );
      if (!claimed) return;

      const employer = await this.prisma.profile.findUnique({
        where: { id: employerId },
        select: { city: true, category: { select: { name: true } } },
      });
      const sector = employer?.category?.name?.trim() || null;
      const city = employer?.city?.trim() || null;

      await this.create({
        recipientId: workerId,
        input: { type: 'PROFILE_VIEW', sector, city },
        actorId: employerId,
      });
      inserted = true;

      await this.maybeRemindOnWhatsApp(workerId);
    } catch (err) {
      if (claimed && !inserted) {
        await this.idempotency.release(dedupeKey).catch(() => undefined);
      }
      this.logger.warn(
        `Profile view notification failed employer=${employerId} worker=${workerId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Nudges the worker on WhatsApp once unread views pile up past the threshold.
   *
   * Paced by one cooldown key per worker rather than reset on read: the point
   * is a worker who never opens the app, and for them "at most once per
   * cooldown" is the whole rule. A worker who does read drops back under the
   * threshold, so they are not reminded until enough new views arrive anyway.
   */
  private async maybeRemindOnWhatsApp(workerId: string): Promise<void> {
    const threshold =
      await this.systemConfig.getProfileViewsWhatsAppThreshold();
    if (threshold <= 0) return;

    const unreadCount = await this.prisma.profileNotification.count({
      where: {
        recipient_id: workerId,
        type: ProfileNotificationType.PROFILE_VIEW,
        read_at: null,
        dismissed_at: null,
      },
    });
    if (unreadCount <= threshold) return;

    const cooldownHours =
      await this.systemConfig.getProfileViewsWhatsAppCooldownHours();
    const claimed = await this.idempotency.claim(
      profileViewsReminderKey(workerId),
      cooldownHours * 60 * 60,
    );
    if (!claimed) return;

    const payload: ProfileViewsThresholdPayload = { workerId, unreadCount };
    this.events.emit(PROFILE_VIEWS_THRESHOLD_EVENT, payload);
  }

  async list(recipientId: string, page: number, limit: number) {
    const where = { recipient_id: recipientId, dismissed_at: null };
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.profileNotification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: PUBLIC_SELECT,
      }),
      this.prisma.profileNotification.count({ where }),
      this.unreadCount(recipientId),
    ]);
    return { items: rows.map(toDto), total, page, limit, unreadCount };
  }

  unreadCount(recipientId: string): Promise<number> {
    return this.prisma.profileNotification.count({
      where: { recipient_id: recipientId, read_at: null, dismissed_at: null },
    });
  }

  /** Scoped by recipient, so an id belonging to someone else is a no-op. */
  async markRead(recipientId: string, id: string): Promise<void> {
    const updated = await this.prisma.profileNotification.updateMany({
      where: { id, recipient_id: recipientId, read_at: null },
      data: { read_at: new Date() },
    });
    if (updated.count > 0) {
      await this.attributeBroadcastReads(recipientId, { id });
    }
  }

  async markAllRead(recipientId: string): Promise<void> {
    // Collected BEFORE the update: afterwards `read_at` is set and the rows
    // are indistinguishable from ones read last week.
    const announcements = await this.unreadAnnouncements(recipientId);

    await this.prisma.profileNotification.updateMany({
      where: { recipient_id: recipientId, read_at: null },
      data: { read_at: new Date() },
    });

    await this.markBroadcastsRead(recipientId, announcements);
  }

  /**
   * Move this person's delivery rows to READ for the broadcasts they just read.
   *
   * Best-effort and never throws: the notification IS read — the row says so —
   * and a reporting counter must not be able to fail that.
   *
   * Only ANNOUNCEMENT rows carry a `broadcastId`, so everything else falls
   * straight through without a query.
   */
  private async attributeBroadcastReads(
    recipientId: string,
    where: { id: string },
  ): Promise<void> {
    try {
      const row = await this.prisma.profileNotification.findUnique({
        where: { id: where.id },
        select: { type: true, metadata: true },
      });
      if (row?.type !== ProfileNotificationType.ANNOUNCEMENT) return;

      const broadcastId = broadcastIdOf(row.metadata);
      if (!broadcastId) return;

      await this.markBroadcastsRead(recipientId, [broadcastId]);
    } catch (err) {
      this.logger.warn(
        `Could not attribute a broadcast read for ${recipientId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** The broadcast ids behind this person's unread announcements. */
  private async unreadAnnouncements(recipientId: string): Promise<string[]> {
    const rows = await this.prisma.profileNotification.findMany({
      where: {
        recipient_id: recipientId,
        read_at: null,
        type: ProfileNotificationType.ANNOUNCEMENT,
      },
      select: { metadata: true },
    });

    return rows
      .map((row) => broadcastIdOf(row.metadata))
      .filter((id): id is string => id !== null);
  }

  private async markBroadcastsRead(
    profileId: string,
    broadcastIds: string[],
  ): Promise<void> {
    for (const broadcastId of new Set(broadcastIds)) {
      try {
        // Only from SENT, so a read can never be counted twice however many
        // times the row is opened.
        const moved = await this.prisma.broadcastRecipient.updateMany({
          where: {
            broadcast_id: broadcastId,
            profile_id: profileId,
            channel: DeliveryChannel.IN_APP,
            status: BroadcastRecipientStatus.SENT,
          },
          data: { status: BroadcastRecipientStatus.READ },
        });
        if (moved.count === 0) continue;

        await this.prisma.broadcast.update({
          where: { id: broadcastId },
          data: { read_count: { increment: moved.count } },
        });
      } catch (err) {
        this.logger.warn(
          `Could not record a read of broadcast ${broadcastId}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Hides one row from its recipient. A cleared notification also counts as
   * read, so it cannot keep a badge — or the WhatsApp reminder — alive.
   */
  async dismiss(recipientId: string, id: string): Promise<void> {
    await this.dismissWhere({ id, recipient_id: recipientId });
  }

  async dismissAll(recipientId: string): Promise<void> {
    await this.dismissWhere({ recipient_id: recipientId });
  }

  private async dismissWhere(
    where: Prisma.ProfileNotificationWhereInput,
  ): Promise<void> {
    const now = new Date();
    // Two statements rather than one: `read_at` must keep its original value
    // on rows that were already read.
    await this.prisma.$transaction([
      this.prisma.profileNotification.updateMany({
        where: { ...where, dismissed_at: null, read_at: null },
        data: { read_at: now },
      }),
      this.prisma.profileNotification.updateMany({
        where: { ...where, dismissed_at: null },
        data: { dismissed_at: now },
      }),
    ]);
  }

  /** The admin view: every row, dismissed included, plus who caused each. */
  async listForAdmin(profileId: string, page: number, limit: number) {
    const where = { recipient_id: profileId };
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.profileNotification.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          ...PUBLIC_SELECT,
          dismissed_at: true,
          actor: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              profile_type: true,
              avatar_url: true,
            },
          },
        },
      }),
      this.prisma.profileNotification.count({ where }),
      this.unreadCount(profileId),
    ]);

    const data: AdminProfileNotificationDto[] = rows.map((row) => ({
      ...toDto(row),
      dismissedAt: row.dismissed_at,
      actor: row.actor
        ? {
            profileId: row.actor.id,
            firstName: row.actor.first_name,
            lastName: row.actor.last_name,
            profileType: row.actor.profile_type,
          }
        : null,
    }));
    return { data, total, page, limit, unreadCount };
  }
}
