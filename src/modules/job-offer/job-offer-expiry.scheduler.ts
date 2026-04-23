import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobOfferStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';

const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class JobOfferExpiryScheduler implements OnModuleInit {
  private readonly logger = new Logger(JobOfferExpiryScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botNotification: BotNotificationService,
  ) {}

  onModuleInit(): void {
    setInterval(() => void this.handleExpiredJobOffers(), INTERVAL_MS);
  }

  async handleExpiredJobOffers(): Promise<void> {
    this.logger.log('Checking for expired job offers…');

    const now = new Date();

    const expired = await this.prisma.jobOffer.findMany({
      where: {
        scheduled_at: { lt: now },
        status: { in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED] },
      },
      select: {
        id: true,
        title: true,
        employer_id: true,
        employer: {
          select: { phone: true, first_name: true },
        },
        applications: {
          where: { status: 'PENDING' },
          select: {
            worker: { select: { phone: true, first_name: true } },
          },
        },
      },
    });

    if (expired.length === 0) {
      this.logger.debug('No expired job offers found.');
      return;
    }

    const ids = expired.map((j) => j.id);

    await this.prisma.jobOffer.updateMany({
      where: { id: { in: ids } },
      data: { status: JobOfferStatus.EXPIRED },
    });

    this.logger.log(`Expired ${ids.length} job offer(s): ${ids.join(', ')}`);

    for (const job of expired) {
      // Notify employer
      if (job.employer?.phone) {
        const msg = [
          `⏰ *Offre expirée*`,
          '',
          `Votre offre *${job.title}* n'a pas été pourvue et a expiré.`,
          'Vous pouvez la republier depuis l\'application.',
        ].join('\n');
        await this.botNotification
          .sendMessage(job.employer.phone, msg)
          .catch((err) =>
            this.logger.warn(
              `Failed to notify employer ${job.employer_id} of job expiry`,
              err,
            ),
          );
      }

      // Notify workers with pending applications
      for (const { worker } of job.applications) {
        if (!worker.phone) continue;
        const msg = [
          `ℹ️ *Offre non disponible*`,
          '',
          `L'offre *${job.title}* pour laquelle vous avez postulé est maintenant expirée.`,
          'De nouvelles offres sont disponibles — tapez *Menu* pour les consulter.',
        ].join('\n');
        await this.botNotification
          .sendMessage(worker.phone, msg)
          .catch((err) =>
            this.logger.warn(
              `Failed to notify worker ${worker.phone} of job expiry`,
              err,
            ),
          );
      }
    }
  }
}
