import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastRecipientStatus,
  BroadcastStatus,
  DeliveryChannel,
  ProfileType,
  type Broadcast,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { BROADCAST_QUEUE } from '../../common/services/queue/queue.module';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { NotificationDispatcher } from '../notification-dispatch/notification-dispatcher.service';
import { ProfileNotificationService } from '../profile-notification/profile-notification.service';
import { flattenForTemplateVariable } from '../../common/utils/whatsapp-template-text.util';
import { broadcastEmail } from '../mail/templates/broadcast';
import { audienceOf, productOf } from '../mail/audience';
import { CHUNK_SIZE } from './broadcast.service';
import type { BroadcastJobData } from './broadcast.types';

/**
 * How long a WhatsApp leg waits between messages, in milliseconds.
 *
 * Meta rate-limits per number, and a broadcast is the only path here that sends
 * hundreds of messages back to back — every other sender is one message about
 * one event. Slow and delivered beats fast and throttled.
 */
const WHATSAPP_PACE_MS = 120;

/** Longest error text kept on a recipient row. */
const ERROR_MAX = 300;

/** Why a recipient got nothing: the profile left after the audience was taken. */
const GONE_SINCE_SCHEDULING = 'Profil archivé ou désinscrit';
@Injectable()
export class BroadcastProcessor {
  private readonly logger = new Logger(BroadcastProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly inApp: ProfileNotificationService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  async process(job: { id?: string; data: BroadcastJobData }): Promise<void> {
    if (job.data.type !== 'dispatch') {
      this.logger.warn(
        `Unknown broadcast job type: ${String((job.data as { type: string }).type)}`,
      );
      return;
    }
    await this.dispatchPage(
      job.data.broadcastId,
      job.data.cursor,
      // Older jobs, queued before runs were identified, keep the previous
      // behaviour rather than crashing on a missing field.
      job.data.runId ?? 'legacy',
    );
  }

  /**
   * Send one page of recipients, then queue the next.
   *
   * Re-queuing rather than looping keeps each job short, so a redeploy or a
   * crash costs one page instead of a whole broadcast, and the cancellation
   * check below gets a chance to run between pages.
   */
  private async dispatchPage(
    broadcastId: string,
    cursor: number,
    runId: string,
  ) {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast) {
      this.logger.warn(`Broadcast ${broadcastId} vanished mid-send`);
      return;
    }

    // Checked every page: an admin who cancels expects the send to stop, and
    // the only honest place to stop is between pages.
    if (broadcast.status === BroadcastStatus.CANCELLED) {
      this.logger.log(`Broadcast ${broadcastId} cancelled — stopping`);
      return;
    }

    if (broadcast.status === BroadcastStatus.SCHEDULED) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.SENDING },
      });
    }

    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: {
        broadcast_id: broadcastId,
        status: BroadcastRecipientStatus.PENDING,
      },
      include: {
        profile: {
          select: {
            id: true,
            phone: true,
            email: true,
            first_name: true,
            whatsapp_connected: true,
            deleted_at: true,
            marketing_opt_out_at: true,
            profile_type: true,
            is_business: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
      take: CHUNK_SIZE,
    });

    if (recipients.length === 0) {
      await this.finish(broadcastId);
      return;
    }

    // The audience was a snapshot taken when the broadcast was scheduled, and
    // delivery can come much later. Anyone archived or who replied STOP since
    // gets nothing (pentest A2-F20, #876): settled FAILED with the reason, and
    // left out of every channel below.
    const gone = recipients.filter(
      (r) => r.profile.deleted_at || r.profile.marketing_opt_out_at,
    );
    for (const r of gone) {
      await this.settle(r.id, GONE_SINCE_SCHEDULING);
    }
    const goneIds = new Set(gone.map((r) => r.id));
    const live = recipients.filter((r) => !goneIds.has(r.id));

    // In-app first, and in one insert: it is free, it never fails for a missing
    // phone or address, and it is the record the other channels point back to.
    const inAppIds = live
      .filter((r) => r.channel === DeliveryChannel.IN_APP)
      .map((r) => r.profile_id);
    if (inAppIds.length) {
      await this.deliverInApp(broadcast, inAppIds);
    }

    // One batched window read for the whole page — the reason
    // `Profile.last_inbound_at` exists. Doing this per recipient would put a
    // query in front of every message.
    const whatsappRecipients = live.filter(
      (r) => r.channel === DeliveryChannel.WHATSAPP,
    );
    const openWindows = whatsappRecipients.length
      ? await this.dispatcher.openWindows(
          whatsappRecipients.map((r) => r.profile_id),
        )
      : new Set<string>();

    for (const recipient of live) {
      if (recipient.channel === DeliveryChannel.IN_APP) continue;

      try {
        const sentAttemptedAt = new Date();
        const sent =
          recipient.channel === DeliveryChannel.WHATSAPP
            ? await this.deliverWhatsApp(
                broadcast,
                // `profile_id` rather than `profile.id`: the FK on the row is
                // what the window map above is keyed on, and the two must not
                // be able to drift apart in a test or a partial select.
                { ...recipient.profile, id: recipient.profile_id },
                openWindows.has(recipient.profile_id),
              )
            : await this.deliverEmail(broadcast, recipient.profile);

        await this.settle(
          recipient.id,
          sent
            ? null
            : await this.providerError(
                recipient.profile_id,
                recipient.channel,
                sentAttemptedAt,
              ),
        );
      } catch (err) {
        await this.settle(
          recipient.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const next = cursor + recipients.length;
    await this.queueService.addJob<BroadcastJobData>(
      BROADCAST_QUEUE,
      { type: 'dispatch', broadcastId, cursor: next, runId },
      // Scoped to the RUN: the same cursor comes round again on a retry, and
      // an id BullMQ has already seen is dropped without a word.
      { jobId: `broadcast-${broadcastId}-${runId}-${next}` },
    );
  }

  private async deliverInApp(
    broadcast: Broadcast,
    recipientIds: string[],
  ): Promise<void> {
    try {
      await this.inApp.createMany(recipientIds, {
        type: 'ANNOUNCEMENT',
        title: broadcast.title,
        body: broadcast.body,
        link: broadcast.link,
        broadcastId: broadcast.id,
      });
      await this.prisma.broadcastRecipient.updateMany({
        where: {
          broadcast_id: broadcast.id,
          profile_id: { in: recipientIds },
          channel: DeliveryChannel.IN_APP,
        },
        data: {
          status: BroadcastRecipientStatus.SENT,
          sent_at: new Date(),
        },
      });
      await this.prisma.broadcast.update({
        where: { id: broadcast.id },
        data: { sent_count: { increment: recipientIds.length } },
      });
    } catch (err) {
      this.logger.warn(
        `In-app leg failed for broadcast ${broadcast.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma.broadcastRecipient.updateMany({
        where: {
          broadcast_id: broadcast.id,
          profile_id: { in: recipientIds },
          channel: DeliveryChannel.IN_APP,
        },
        data: {
          status: BroadcastRecipientStatus.FAILED,
          error: 'Insertion du fil in-app échouée',
        },
      });
      await this.prisma.broadcast.update({
        where: { id: broadcast.id },
        data: { failed_count: { increment: recipientIds.length } },
      });
    }
  }

  /**
   * The WhatsApp leg, through the dispatcher.
   *
   * Free-form when the window is open, the approved MARKETING template
   * otherwise — the split the admin was shown as a cost before confirming. The
   * window verdict is passed in so the dispatcher does not read it again.
   */
  private async deliverWhatsApp(
    broadcast: Broadcast,
    profile: { id: string; phone: string; first_name: string },
    windowOpen: boolean,
  ): Promise<boolean> {
    if (!profile.phone) return false;

    await pace(WHATSAPP_PACE_MS);

    const { sent } = await this.dispatcher.send({
      phone: profile.phone,
      profileId: profile.id,
      template: {
        key: 'broadcastAnnouncement',
        params: {
          firstName: profile.first_name,
          // Meta rejects a newline inside a variable (132018), and an admin's
          // message is written in a textarea.
          message: flattenForTemplateVariable(broadcast.body),
          path: broadcast.link ?? 'home',
        },
      },
      freeForm: {
        body: `*${broadcast.title}*\n\n${broadcast.body}`,
        buttonText: 'Ouvrir Rabotka',
        path: broadcast.link ?? 'home',
      },
      windowOpen,
    });

    return sent;
  }

  private async deliverEmail(
    broadcast: Broadcast,
    profile: {
      email: string | null;
      first_name: string;
      profile_type: ProfileType;
      is_business: boolean;
    },
  ): Promise<boolean> {
    if (!profile.email) return false;

    await this.mail.sendMail({
      to: profile.email,
      subject: broadcast.title,
      html: await this.layout.wrap(
        // The title rides on `subject` only — the body no longer repeats it.
        broadcastEmail({
          firstName: profile.first_name,
          body: broadcast.body,
          link: broadcast.link,
          audience: audienceOf(profile),
        }),
        { product: productOf(audienceOf(profile)) },
      ),
    });
    return true;
  }

  /**
   * Why a send failed, in the provider's own words.
   *
   * `sendTemplateMessage` reports a boolean — the real error is logged and
   * swallowed, which left every failed row saying "Non délivré" and sent the
   * reader to the worker logs to find out that a template was never approved.
   *
   * The delivery log already holds the answer: `WhatsappMessageLogService`
   * writes the error code and message against the same profile, moments
   * earlier. Reading it back is indirect, but it is the system of record for
   * sends and it costs one indexed query on a path that has already failed.
   */
  private async providerError(
    profileId: string,
    channel: DeliveryChannel,
    since: Date,
  ): Promise<string> {
    if (channel !== DeliveryChannel.WHATSAPP) return 'Non délivré';

    try {
      const row = await this.prisma.whatsappMessage.findFirst({
        where: {
          profile_id: profileId,
          created_at: { gte: new Date(since.getTime() - 5_000) },
          error_message: { not: null },
        },
        orderBy: { created_at: 'desc' },
        select: { error_code: true, error_message: true },
      });
      if (!row?.error_message) return 'Non délivré';

      return row.error_code
        ? `${row.error_code}: ${row.error_message}`
        : row.error_message;
    } catch {
      // The reason is a nicety; the failure itself is already recorded.
      return 'Non délivré';
    }
  }

  /** Record one recipient's outcome and move the broadcast's counters. */
  private async settle(recipientId: string, error: string | null) {
    await this.prisma.broadcastRecipient.update({
      where: { id: recipientId },
      data: {
        status: error
          ? BroadcastRecipientStatus.FAILED
          : BroadcastRecipientStatus.SENT,
        error: error ? error.slice(0, ERROR_MAX) : null,
        sent_at: error ? null : new Date(),
      },
    });

    const recipient = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
      select: { broadcast_id: true },
    });
    if (!recipient) return;

    await this.prisma.broadcast.update({
      where: { id: recipient.broadcast_id },
      data: error
        ? { failed_count: { increment: 1 } }
        : { sent_count: { increment: 1 } },
    });
  }

  /**
   * Close the broadcast, honestly.
   *
   * FAILED when nothing got through — a run where every delivery was rejected
   * is not a send, and labelling it SENT is how a broken template (or an
   * expired token) goes unnoticed until someone asks why nobody replied. The
   * enum had a FAILED state from the start; nothing ever set it.
   */
  private async finish(broadcastId: string): Promise<void> {
    const current = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
      select: { sent_count: true, failed_count: true },
    });

    const nothingDelivered =
      (current?.sent_count ?? 0) === 0 && (current?.failed_count ?? 0) > 0;

    const broadcast = await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: {
        status: nothingDelivered
          ? BroadcastStatus.FAILED
          : BroadcastStatus.SENT,
        sent_at: new Date(),
      },
    });

    this.logger.log(
      `Broadcast ${broadcastId} finished: ${broadcast.sent_count} sent, ` +
        `${broadcast.failed_count} failed of ${broadcast.recipient_count}`,
    );
  }
}

/** Wait, so the WhatsApp leg stays under Meta's per-number rate limit. */
function pace(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
