import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { PENALTY_NOTIFICATIONS_QUEUE } from '../../common/services/queue/queue.module';
import { PENALTIES_PAYMENT_CTA_PATH } from '../../common/constants/whatsapp-templates';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { formatPenaltyReminderDay } from '../bot/messages/penalty.messages';
import { SystemConfigService } from '../system-config/system-config.service';
import { hardBlockCutoff } from './penalty.utils';

export type PenaltyNotificationJobData =
  { type: 'scan' } | { type: 'notify_penalty'; penaltyId: string };

@Injectable()
export class PenaltyNotificationProcessor {
  private readonly logger = new Logger(PenaltyNotificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async process(job: {
    id?: string;
    data: PenaltyNotificationJobData;
  }): Promise<void> {
    if (job.data.type === 'scan') {
      await this.runScan();
      return;
    }
    if (job.data.type === 'notify_penalty') {
      await this.sendPenaltyReminder(job.data.penaltyId);
      return;
    }
    this.logger.warn(
      `Unknown penalty-notification job type: ${String((job.data as { type: string }).type)}`,
    );
  }

  private async runScan(): Promise<void> {
    const now = new Date();
    const { maxNotifications, notificationIntervalHours, hardBlockDays } =
      await this.systemConfig.getPenaltyNotificationConfig();
    const intervalAgo = new Date(
      now.getTime() - notificationIntervalHours * 60 * 60 * 1000,
    );
    // Stop reminding once the penalty has hard-blocked the account: at that
    // point the block itself is the message. This used to be derived from
    // `MAX_NOTIFICATIONS × 24h`, which happened to equal the hard-block window
    // only because both constants were 3 — changing either would have silently
    // desynced the reminder run from the block it leads up to.
    const cutoff = hardBlockCutoff(hardBlockDays);

    const penalties = await this.prisma.penalty.findMany({
      where: {
        paid_at: null,
        notification_count: { lt: maxNotifications },
        applied_at: { gte: cutoff },
        OR: [
          { last_notified_at: null },
          { last_notified_at: { lte: intervalAgo } },
        ],
      },
      select: { id: true },
    });

    this.logger.log(
      `Penalty notification scan: ${penalties.length} penalty(ies) eligible`,
    );

    const today = now.toISOString().slice(0, 10);
    for (const penalty of penalties) {
      await this.queueService.addJob<PenaltyNotificationJobData>(
        PENALTY_NOTIFICATIONS_QUEUE,
        { type: 'notify_penalty', penaltyId: penalty.id },
        { jobId: `penalty-notify-${penalty.id}-${today}` },
      );
    }
  }

  private async sendPenaltyReminder(penaltyId: string): Promise<void> {
    const now = new Date();
    const { maxNotifications, notificationIntervalHours } =
      await this.systemConfig.getPenaltyNotificationConfig();
    const intervalAgo = new Date(
      now.getTime() - notificationIntervalHours * 60 * 60 * 1000,
    );

    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
      include: {
        profile: { select: { phone: true, first_name: true } },
      },
    });

    if (!penalty) {
      this.logger.warn(`Penalty ${penaltyId} not found, skipping`);
      return;
    }
    if (penalty.paid_at) {
      this.logger.debug(`Penalty ${penaltyId} already paid, skipping`);
      return;
    }
    if (penalty.notification_count >= maxNotifications) {
      this.logger.debug(
        `Penalty ${penaltyId} already at max notifications, skipping`,
      );
      return;
    }
    if (penalty.last_notified_at && penalty.last_notified_at > intervalAgo) {
      this.logger.debug(`Penalty ${penaltyId} notified too recently, skipping`);
      return;
    }

    const totalUnpaid = await this.prisma.penalty.aggregate({
      where: { profile_id: penalty.profile_id, paid_at: null },
      _sum: { amount: true },
    });

    const dayNumber = penalty.notification_count + 1;
    const text = formatPenaltyReminderDay({
      firstName: penalty.profile.first_name ?? '',
      amount: Number(penalty.amount),
      dayNumber,
      totalUnpaid: Number(totalUnpaid._sum.amount ?? penalty.amount),
    });

    // Sent as a free message with a button, which WhatsApp only delivers while
    // the person has written to us in the last 24 hours. Outside that window
    // the reminder waits: it is not counted, so the next scan tries again.
    const window = await this.whatsApp.isServiceWindowOpen(penalty.profile_id);
    if (!window.open) {
      this.logger.debug(
        `Penalty ${penaltyId}: WhatsApp window closed, reminder postponed`,
      );
      return;
    }

    const url = await this.loginLink.shortLink(
      penalty.profile_id,
      PENALTIES_PAYMENT_CTA_PATH,
    );
    if (!url) {
      this.logger.warn(
        `Penalty ${penaltyId}: no sign-in link for profile ${penalty.profile_id}, reminder skipped`,
      );
      return;
    }

    try {
      const sent = await this.whatsApp.sendInteractiveCta(
        penalty.profile.phone,
        {
          body: text,
          buttonText: 'Payer mes pénalités',
          url,
          profileId: penalty.profile_id,
        },
      );
      if (!sent) {
        throw new Error('WhatsApp did not accept the reminder');
      }

      await this.prisma.penalty.update({
        where: { id: penaltyId },
        data: {
          notification_count: { increment: 1 },
          last_notified_at: now,
        },
      });

      this.logger.log(
        `Penalty reminder day ${dayNumber} sent for penalty ${penaltyId} to profile ${penalty.profile_id}`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to send penalty reminder for ${penaltyId}`,
        err,
      );
      throw err;
    }
  }
}
