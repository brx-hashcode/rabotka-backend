import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { PENALTY_NOTIFICATIONS_QUEUE } from '../../common/services/queue/queue.module';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { formatPenaltyReminderDay } from '../bot/messages/penalty.messages';

export type PenaltyNotificationJobData =
  | { type: 'scan' }
  | { type: 'notify_penalty'; penaltyId: string };

const MAX_NOTIFICATIONS = 3;
const TWENTY_THREE_HOURS_MS = 23 * 60 * 60 * 1000;

@Injectable()
export class PenaltyNotificationProcessor implements OnModuleInit {
  private readonly logger = new Logger(PenaltyNotificationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly botNotification: BotNotificationService,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<PenaltyNotificationJobData>(
      PENALTY_NOTIFICATIONS_QUEUE,
      (job) => this.process(job),
      { concurrency: 3 },
    );
  }

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
    const twentyThreeHoursAgo = new Date(now.getTime() - TWENTY_THREE_HOURS_MS);
    const hardBlockCutoff = new Date(
      now.getTime() - MAX_NOTIFICATIONS * 24 * 60 * 60 * 1000,
    );

    const penalties = await this.prisma.penalty.findMany({
      where: {
        paid_at: null,
        notification_count: { lt: MAX_NOTIFICATIONS },
        applied_at: { gte: hardBlockCutoff },
        OR: [
          { last_notified_at: null },
          { last_notified_at: { lte: twentyThreeHoursAgo } },
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
    const twentyThreeHoursAgo = new Date(now.getTime() - TWENTY_THREE_HOURS_MS);

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
    if (penalty.notification_count >= MAX_NOTIFICATIONS) {
      this.logger.debug(
        `Penalty ${penaltyId} already at max notifications, skipping`,
      );
      return;
    }
    if (
      penalty.last_notified_at &&
      penalty.last_notified_at > twentyThreeHoursAgo
    ) {
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

    try {
      await this.botNotification.sendMessage(penalty.profile.phone, text);

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
