import { Injectable, Logger } from '@nestjs/common';
import { AdStatus, AdDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AdTargetingService } from './ad-targeting.service';
import { AdvertisementService } from './advertisement.service';
import { EventNotificationDispatcher } from '../../event/services/event-notification.dispatcher';
import type { EventNotificationRecipient } from '../../event/interfaces/event-notification.interfaces';

export type AdJobData = { type: 'lifecycle' } | { type: 'dispatch' };

type AdWithBundle = Awaited<ReturnType<PrismaService['advertisement']['findFirst']>> & {
  bundle: {
    allowed_channels: string[];
    max_reach: number;
    max_frequency_per_week: number;
  };
};

@Injectable()
export class AdProcessor {
  private readonly logger = new Logger(AdProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adTargeting: AdTargetingService,
    private readonly advertisementService: AdvertisementService,
    private readonly eventNotificationDispatcher: EventNotificationDispatcher,
  ) {}

  async process(job: { id?: string; data: AdJobData }): Promise<void> {
    const { type } = job.data;

    if (type === 'lifecycle') {
      await this.runLifecycle();
    } else if (type === 'dispatch') {
      await this.runDispatch();
    } else {
      this.logger.warn(`Unknown ad job type: ${String(type)}`);
    }
  }

  private async runLifecycle(): Promise<void> {
    const now = new Date();

    const activated = await this.prisma.advertisement.updateMany({
      where: {
        status: AdStatus.APPROVED,
        start_date: { lte: now },
      },
      data: { status: AdStatus.ACTIVE },
    });

    const completed = await this.prisma.advertisement.updateMany({
      where: {
        status: AdStatus.ACTIVE,
        end_date: { lt: now },
      },
      data: { status: AdStatus.COMPLETED },
    });

    if (activated.count > 0 || completed.count > 0) {
      this.logger.log(
        `Lifecycle: ${activated.count} ads activated, ${completed.count} ads completed`,
      );
    }
  }

  private async runDispatch(): Promise<void> {
    const activeAds = await this.prisma.advertisement.findMany({
      where: { status: AdStatus.ACTIVE },
      include: { bundle: true },
    });

    for (const ad of activeAds) {
      if (!(await this.isDispatchDue(ad))) continue;

      try {
        await this.dispatchAd(ad);
      } catch (err) {
        this.logger.error(
          `Failed to dispatch advertisement ${ad.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async dispatchAd(ad: NonNullable<AdWithBundle>): Promise<void> {
    const channel = ad.bundle.allowed_channels[0];
    if (!channel) {
      this.logger.warn(`Advertisement ${ad.id} bundle has no allowed channels — skipping`);
      return;
    }

    const profiles = await this.adTargeting.resolveRecipients(ad);
    if (profiles.length === 0) {
      this.logger.debug(`No recipients found for advertisement ${ad.id}`);
      return;
    }

    const recipients: EventNotificationRecipient[] = profiles.map((p) => ({
      email: p.email,
      phone: p.phone ?? undefined,
      name: `${p.first_name} ${p.last_name}`,
    }));

    const payload = {
      eventId: ad.id,
      title: ad.title,
      startDate: ad.start_date.toISOString(),
      endDate: ad.end_date.toISOString(),
      description: ad.description,
      location: ad.cta_url ?? null,
    };

    await this.eventNotificationDispatcher.dispatchEventCreated(
      recipients,
      payload,
      channel as never,
    );

    await this.prisma.adDeliveryLog.createMany({
      data: profiles.map((p) => ({
        advertisement_id: ad.id,
        profile_id: p.id,
        channel: channel as never,
        status: AdDeliveryStatus.SENT,
        sent_at: new Date(),
      })),
    });

    await this.advertisementService.updateMetrics(ad.id, 'total_sent');

    this.logger.log(
      `Dispatched advertisement ${ad.id} to ${profiles.length} recipients`,
    );
  }

  private async isDispatchDue(ad: { id: string; start_date: Date; bundle: { max_frequency_per_week: number } }): Promise<boolean> {
    const now = new Date();
    const daysSinceStart = Math.floor(
      (now.getTime() - ad.start_date.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Use bundle frequency: treat max_frequency_per_week as the weekly send rate
    const expectedSends =
      Math.floor((daysSinceStart / 7) * ad.bundle.max_frequency_per_week) + 1;

    const actualSends = await this.prisma.adDeliveryLog.count({
      where: {
        advertisement_id: ad.id,
        status: AdDeliveryStatus.SENT,
      },
    });

    return actualSends < expectedSends;
  }
}
