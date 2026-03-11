import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import {
  formatReminder24h,
  formatReminder2h,
} from '../messages/notifications.messages';
import { ApplicationStatus, JobOfferStatus } from '@prisma/client';

const REMINDER_24H_SENT_KEY = 'reminder:sent:24h:';
const REMINDER_2H_SENT_KEY = 'reminder:sent:2h:';
const SENT_KEY_TTL = 48 * 60 * 60;

export type ReminderJobData =
  | { type: 'scan' }
  | { type: 'reminder_24h'; applicationId: string }
  | { type: 'reminder_2h'; applicationId: string };

@Injectable()
export class ReminderProcessor {
  private readonly logger = new Logger(ReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly queueService: QueueService,
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
  ) {}

  async process(job: { id?: string; data: ReminderJobData }): Promise<void> {
    const { type } = job.data;

    if (type === 'scan') {
      await this.runScan();
      return;
    }

    if (type === 'reminder_24h') {
      await this.sendReminder24h(job.data.applicationId);
      return;
    }

    if (type === 'reminder_2h') {
      await this.sendReminder2h(job.data.applicationId);
      return;
    }

    this.logger.warn(`Unknown reminder job type: ${String(type)}`);
  }

  private async runScan(): Promise<void> {
    await this.expireOverdueOffers();
    const now = new Date();
    const window24hStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const window24hEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const window2hStart = new Date(now.getTime() + (2 * 60 - 10) * 60 * 1000);
    const window2hEnd = new Date(now.getTime() + (2 * 60 + 10) * 60 * 1000);

    const [apps24h, apps2h] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          status: ApplicationStatus.ACCEPTED,
          job_offer: {
            scheduled_at: {
              gte: window24hStart,
              lte: window24hEnd,
            },
          },
        },
        select: { id: true },
      }),
      this.prisma.application.findMany({
        where: {
          status: ApplicationStatus.ACCEPTED,
          job_offer: {
            scheduled_at: {
              gte: window2hStart,
              lte: window2hEnd,
            },
          },
        },
        select: { id: true },
      }),
    ]);

    for (const app of apps24h) {
      const key = `${REMINDER_24H_SENT_KEY}${app.id}`;
      const sent = await this.redis.get(key);
      if (!sent) {
        await this.queueService.addJob<ReminderJobData>(
          WHATSAPP_REMINDERS_QUEUE,
          { type: 'reminder_24h', applicationId: app.id },
          { jobId: `24h-${app.id}` },
        );
      }
    }

    for (const app of apps2h) {
      const key = `${REMINDER_2H_SENT_KEY}${app.id}`;
      const sent = await this.redis.get(key);
      if (!sent) {
        await this.queueService.addJob<ReminderJobData>(
          WHATSAPP_REMINDERS_QUEUE,
          { type: 'reminder_2h', applicationId: app.id },
          { jobId: `2h-${app.id}` },
        );
      }
    }
  }

  private async expireOverdueOffers(): Promise<void> {
    const now = new Date();

    const overdueOffers = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        scheduled_at: { lt: now },
      },
      select: {
        id: true,
        title: true,
        employer_id: true,
        employer: { select: { phone: true, first_name: true } },
      },
    });

    if (overdueOffers.length === 0) return;

    const ids = overdueOffers.map((o) => o.id);
    await this.prisma.jobOffer.updateMany({
      where: { id: { in: ids } },
      data: { status: JobOfferStatus.EXPIRED },
    });

    this.logger.log(`Expired ${ids.length} overdue job offer(s)`);

    for (const offer of overdueOffers) {
      const phone = offer.employer?.phone;
      if (!phone) continue;
      const firstName = offer.employer?.first_name ?? '';
      const text = [
        `*⏰ Offre expirée*`,
        '',
        `Bonjour ${firstName}, votre offre *"${offer.title}"* a expiré car la date programmée est passée sans qu'aucun travailleur ne soit assigné.`,
        '',
        `Tapez *MENU* pour publier une nouvelle offre.`,
      ].join('\n');
      await this.whatsApp
        .sendTextMessage(phone, text, offer.employer_id)
        .catch((err) =>
          this.logger.warn(
            `Failed to notify employer ${offer.employer_id} of expired offer`,
            err,
          ),
        );
    }
  }

  private async sendReminder24h(applicationId: string): Promise<void> {
    const key = `${REMINDER_24H_SENT_KEY}${applicationId}`;
    const sent = await this.redis.get(key);
    if (sent) {
      this.logger.debug(`Reminder 24h already sent for ${applicationId}`);
      return;
    }

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { employer: true } },
        worker: true,
      },
    });

    if (!app?.worker?.phone || app.status !== 'ACCEPTED') return;

    const text = formatReminder24h({
      offerTitle: app.job_offer.title,
      scheduledAt: app.job_offer.scheduled_at,
      address: app.job_offer.address,
      amount: Number(app.job_offer.amount),
      employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
      employerPhone: app.job_offer.employer.phone,
    });

    await this.whatsApp.sendTextMessage(app.worker.phone, text);
    await this.redis.set(key, '1', 'EX', SENT_KEY_TTL);
    this.logger.log(`Reminder 24h sent for application ${applicationId}`);
  }

  private async sendReminder2h(applicationId: string): Promise<void> {
    const key = `${REMINDER_2H_SENT_KEY}${applicationId}`;
    const sent = await this.redis.get(key);
    if (sent) {
      this.logger.debug(`Reminder 2h already sent for ${applicationId}`);
      return;
    }

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { employer: true } },
        worker: true,
      },
    });

    if (!app?.worker?.phone || app.status !== 'ACCEPTED') return;

    const text = formatReminder2h({
      offerTitle: app.job_offer.title,
      scheduledAt: app.job_offer.scheduled_at,
      address: app.job_offer.address,
      employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
      employerPhone: app.job_offer.employer.phone,
    });

    await this.whatsApp.sendTextMessage(app.worker.phone, text);
    await this.redis.set(key, '1', 'EX', SENT_KEY_TTL);
    this.logger.log(`Reminder 2h sent for application ${applicationId}`);
  }
}
