import { Injectable, Logger } from '@nestjs/common';
import { AdDeliveryStatus, AdStatus, DeliveryChannel } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AdLinkTrackingService } from './ad-link-tracking.service';
import type { InAppAdPayload } from '../gateways/ad-inbox.gateway';

/** Never flood a returning user: show at most this many pending popups. */
const MAX_PENDING = 5;

/**
 * Reads the IN_APP side of `ad_delivery_logs`: one unopened row is one pending
 * popup for that profile. `opened_at` doubles as the "dismissed" flag — set by
 * the client closing the card, or by the /r/:hash redirect when the CTA is
 * clicked.
 */
@Injectable()
export class AdInboxService {
  private readonly logger = new Logger(AdInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adLinkTracking: AdLinkTrackingService,
  ) {}

  async listPending(profileId: string): Promise<InAppAdPayload[]> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const logs = await this.prisma.adDeliveryLog.findMany({
      where: {
        profile_id: profileId,
        channel: DeliveryChannel.IN_APP,
        status: AdDeliveryStatus.SENT,
        opened_at: null,
        advertisement: {
          status: AdStatus.ACTIVE,
          end_date: { gte: todayStart },
        },
      },
      orderBy: { sent_at: 'asc' },
      take: MAX_PENDING,
      select: {
        id: true,
        advertisement: {
          select: {
            id: true,
            title: true,
            description: true,
            image_urls: true,
            banner_url: true,
            call_to_action: true,
            cta_url: true,
            tags: true,
          },
        },
        tracked_links: {
          select: { hash: true },
          orderBy: { created_at: 'asc' },
          take: 1,
        },
      },
    });

    return logs.map((log) => {
      const hash = log.tracked_links[0]?.hash;

      return {
        deliveryId: log.id,
        advertisementId: log.advertisement.id,
        title: log.advertisement.title,
        description: log.advertisement.description,
        imageUrl:
          log.advertisement.banner_url ?? log.advertisement.image_urls[0] ?? null,
        callToAction: log.advertisement.call_to_action,
        tags: log.advertisement.tags,
        // Prefer the tracked redirect so in-app clicks land in the same
        // analytics as email/WhatsApp ones; fall back to the raw URL if the
        // link could not be tracked at dispatch time.
        ctaUrl: hash
          ? this.adLinkTracking.buildTrackedUrl(hash)
          : log.advertisement.cta_url,
      };
    });
  }

  /**
   * Marks a delivery as seen. Scoped by profile so one user cannot dismiss
   * another's delivery, and idempotent — re-closing an already-seen ad is a
   * no-op rather than an error.
   */
  async markSeen(profileId: string, deliveryId: string): Promise<void> {
    const { count } = await this.prisma.adDeliveryLog.updateMany({
      where: {
        id: deliveryId,
        profile_id: profileId,
        channel: DeliveryChannel.IN_APP,
        opened_at: null,
      },
      data: { opened_at: new Date() },
    });

    if (count === 0) return;

    await this.prisma.adDeliveryLog
      .findUnique({
        where: { id: deliveryId },
        select: { advertisement_id: true },
      })
      .then((log) => {
        if (!log) return;
        return this.prisma.advertisement.update({
          where: { id: log.advertisement_id },
          data: { total_opened: { increment: 1 } },
        });
      })
      .catch((err: unknown) => {
        // The dismissal itself succeeded — a failed counter bump must not 500.
        this.logger.error(
          `Failed to increment total_opened for delivery ${deliveryId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
  }
}
