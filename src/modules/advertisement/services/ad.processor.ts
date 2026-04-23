import { Injectable, Logger } from '@nestjs/common';
import { AdStatus, AdDeliveryStatus, DeliveryChannel } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AdTargetingService } from './ad-targeting.service';
import { AdLinkTrackingService } from './ad-link-tracking.service';
import { AdNotificationService } from './ad-notification.service';
import { AdReportService } from './ad-report.service';
import { NotificationService } from '../../notification/notification.service';

export type AdJobData = { type: 'lifecycle' } | { type: 'dispatch' };

type AdWithBundle = Awaited<
  ReturnType<PrismaService['advertisement']['findFirst']>
> & {
  bundle: {
    allowed_channels: string[];
    max_reach: number;
    max_frequency_per_week: number;
    target_audience: string;
  };
};

@Injectable()
export class AdProcessor {
  private readonly logger = new Logger(AdProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adTargeting: AdTargetingService,
    private readonly adNotificationService: AdNotificationService,
    private readonly adLinkTracking: AdLinkTrackingService,
    private readonly adReport: AdReportService,
    private readonly notificationService: NotificationService,
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

    if (completed.count > 0) {
      await this.sendCompletionReports(now);
    }
  }

  private async sendCompletionReports(completedAt: Date): Promise<void> {
    const windowStart = new Date(completedAt.getTime() - 2 * 60 * 1000);

    const ads = await this.prisma.advertisement.findMany({
      where: {
        status: AdStatus.COMPLETED,
        updated_at: { gte: windowStart },
      },
      select: {
        id: true,
        title: true,
        start_date: true,
        end_date: true,
        contact_email: true,
      },
    });

    for (const ad of ads) {
      if (!ad.contact_email) continue;
      try {
        const excelBuffer = await this.adReport.generateExcel(ad.id, ad.title);
        const stats = await this.adReport.getStats(ad.id);
        await this.notificationService.notifyAdvertisementCompleted({
          to: ad.contact_email,
          adTitle: ad.title,
          startDate: ad.start_date.toISOString(),
          endDate: ad.end_date.toISOString(),
          stats,
          excelBuffer,
        });
        this.logger.log(`Completion report sent for advertisement ${ad.id} to ${ad.contact_email}`);
      } catch (err) {
        this.logger.error(
          `Failed to send completion report for advertisement ${ad.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
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
    const channels = ad.bundle.allowed_channels;
    if (channels.length === 0) {
      this.logger.warn(
        `Advertisement ${ad.id} bundle has no allowed channels — skipping`,
      );
      return;
    }

    const profiles = await this.adTargeting.resolveRecipients(ad);
    if (profiles.length === 0) {
      this.logger.debug(`No recipients found for advertisement ${ad.id}`);
      return;
    }

    const basePayload = {
      advertisementId: ad.id,
      title: ad.title,
      startDate: ad.start_date.toISOString(),
      endDate: ad.end_date.toISOString(),
      description: ad.description,
      ctaUrl: ad.cta_url ?? null,
      callToAction: ad.call_to_action ?? null,
      imageUrl: ad.image_urls?.[0] ?? null,
      tags: ad.tags ?? null,
    };
    let sentCount = 0;

    for (const p of profiles) {
      for (const channel of channels) {
        const deliveryLog = await this.prisma.adDeliveryLog.create({
          data: {
            advertisement_id: ad.id,
            profile_id: p.id,
            channel: channel as never,
            status: AdDeliveryStatus.SENT,
            sent_at: new Date(),
          },
        });
        const payload = await this.adLinkTracking.buildTrackedPayload({
          advertisementId: ad.id,
          deliveryLogId: deliveryLog.id,
          channel: channel as never,
          payload: basePayload,
        });
        const recipient = {
          email: p.email,
          phone: p.phone ?? undefined,
          name: `${p.first_name} ${p.last_name}`,
        };
        await this.adNotificationService.dispatchCreated(
          recipient,
          payload,
          channel as DeliveryChannel,
        );
        sentCount += 1;
      }
    }

    await this.prisma.advertisement.update({
      where: { id: ad.id },
      data: { total_sent: { increment: sentCount } },
    });

    this.logger.log(
      `Dispatched advertisement ${ad.id} to ${profiles.length} recipients via [${channels.join(', ')}]`,
    );
  }

  private async isDispatchDue(ad: {
    id: string;
    start_date: Date;
    dispatch_time: string;
    bundle: { max_frequency_per_week: number };
  }): Promise<boolean> {
    const now = new Date();

    // Parse the ad's configured dispatch time (HH:MM UTC)
    const [dispatchHour, dispatchMinute] = ad.dispatch_time
      .split(':')
      .map(Number);
    const dispatchTodayUtc = new Date();
    dispatchTodayUtc.setUTCHours(dispatchHour, dispatchMinute, 0, 0);

    // Don't dispatch before today's scheduled time
    if (now < dispatchTodayUtc) return false;

    // Guard: if any delivery already went out today, skip — prevents re-sending every 15 min
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const sentToday = await this.prisma.adDeliveryLog.count({
      where: { advertisement_id: ad.id, sent_at: { gte: todayStart } },
    });
    if (sentToday > 0) return false;

    const daysSinceStart = Math.floor(
      (now.getTime() - ad.start_date.getTime()) / (1000 * 60 * 60 * 24),
    );

    const expectedBatches =
      Math.floor((daysSinceStart / 7) * ad.bundle.max_frequency_per_week) + 1;

    // Count distinct dispatch days (one batch per calendar day)
    const rows = await this.prisma.$queryRaw<{ day: string }[]>`
      SELECT DISTINCT DATE(sent_at) AS day
      FROM "ad_delivery_logs"
      WHERE advertisement_id = ${ad.id}::uuid
        AND status = 'SENT'
        AND sent_at IS NOT NULL
    `;
    const actualBatches = rows.length;

    return actualBatches < expectedBatches;
  }
}
