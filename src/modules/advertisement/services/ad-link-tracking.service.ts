import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryChannel, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { AdNotificationPayload } from './ad-notification.service';

type TrackedPayloadContext = {
  advertisementId: string;
  deliveryLogId: string;
  channel: DeliveryChannel;
  payload: AdNotificationPayload;
};

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]}]+/gi;

@Injectable()
export class AdLinkTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async buildTrackedPayload(
    ctx: TrackedPayloadContext,
  ): Promise<AdNotificationPayload> {
    const trackedByOriginal = new Map<string, string>();
    const rewrite = async (value: string | null | undefined) => {
      if (!value) return value;
      const urls = this.extractUrls(value);
      if (urls.length === 0) return value;

      let rewritten = value;
      for (const original of urls) {
        let tracked = trackedByOriginal.get(original);
        if (!tracked) {
          tracked = await this.createTrackedUrl(
            ctx.advertisementId,
            ctx.deliveryLogId,
            ctx.channel,
            original,
          );
          trackedByOriginal.set(original, tracked);
        }
        rewritten = rewritten.split(original).join(tracked);
      }
      return rewritten;
    };

    return {
      ...ctx.payload,
      title: (await rewrite(ctx.payload.title)) ?? ctx.payload.title,
      description: await rewrite(ctx.payload.description),
      ctaUrl: await rewrite(ctx.payload.ctaUrl),
      callToAction: await rewrite(ctx.payload.callToAction),
    };
  }

  async resolveAndTrackClick(
    hash: string,
    metadata: { ip?: string; userAgent?: string },
  ): Promise<string> {
    const tracked = await this.prisma.adTrackedLink.findUnique({
      where: { hash },
      select: {
        id: true,
        advertisement_id: true,
        ad_delivery_log_id: true,
        original_url: true,
      },
    });
    if (!tracked) {
      throw new NotFoundException('Tracked link not found');
    }

    const now = new Date();

    const deliveryLog = await this.prisma.adDeliveryLog.findUnique({
      where: { id: tracked.ad_delivery_log_id },
      select: { clicked_at: true, opened_at: true },
    });

    const isFirstClick = deliveryLog?.clicked_at === null;
    const isFirstOpen = deliveryLog?.opened_at === null;

    await this.prisma.$transaction([
      this.prisma.adTrackedLink.update({
        where: { id: tracked.id },
        data: {
          click_count: { increment: 1 },
          last_clicked_at: now,
          last_click_ip: metadata.ip,
          last_click_ua: metadata.userAgent,
        },
      }),
      this.prisma.advertisement.update({
        where: { id: tracked.advertisement_id },
        data: {
          total_clicks: { increment: 1 },
          ...(isFirstOpen && { total_opened: { increment: 1 } }),
        },
      }),
      this.prisma.adDeliveryLog.update({
        where: { id: tracked.ad_delivery_log_id },
        data: {
          ...(isFirstClick && { clicked_at: now }),
          ...(isFirstOpen && { opened_at: now }),
        },
      }),
    ]);

    return tracked.original_url;
  }

  /**
   * Public redirect URL for an already-created tracked link. In-app deliveries
   * are read back long after dispatch, so the popup rebuilds the CTA from the
   * stored hash instead of keeping a rendered copy of the payload.
   */
  buildTrackedUrl(hash: string): string {
    return `${this.getTrackingBaseUrl()}/${hash}`;
  }

  private extractUrls(value: string): string[] {
    const matches = value.match(URL_REGEX) ?? [];
    const unique = Array.from(new Set(matches));
    return unique.filter((url) => this.isValidHttpUrl(url));
  }

  private async createTrackedUrl(
    advertisementId: string,
    deliveryLogId: string,
    channel: DeliveryChannel,
    originalUrl: string,
  ): Promise<string> {
    if (!this.isValidHttpUrl(originalUrl)) {
      throw new BadRequestException('Invalid URL for ad tracking');
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const hash = randomBytes(6).toString('base64url');
      try {
        await this.prisma.adTrackedLink.create({
          data: {
            hash,
            advertisement_id: advertisementId,
            ad_delivery_log_id: deliveryLogId,
            original_url: originalUrl,
            channel,
          },
        });
        return `${this.getTrackingBaseUrl()}/${hash}`;
      } catch (error: unknown) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          continue;
        }
        throw error;
      }
    }

    throw new Error('Unable to allocate unique tracking hash');
  }

  private getTrackingBaseUrl(): string {
    const base = (
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('FRONTEND_LINK') ??
      ''
    ).trim();
    if (!base) {
      throw new Error(
        'FRONTEND_URL (or FRONTEND_LINK) must be configured for ad link tracking',
      );
    }
    return `${base.replace(/\/+$/, '')}/r`;
  }

  private isValidHttpUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
