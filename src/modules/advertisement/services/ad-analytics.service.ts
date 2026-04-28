import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

export interface AdStats {
  totalSent: number;
  totalOpened: number;
  totalClicks: number;
  openRate: number;
  clickRate: number;
  clickedDeliveries: number;
  clickThroughRate: number;
  remainingDays: number;
  links: {
    hash: string;
    originalUrl: string;
    clickCount: number;
    lastClickedAt: Date | null;
  }[];
}

export interface AdTimelinePoint {
  date: string;
  sent: number;
  clicked: number;
  failed: number;
}

export interface AdDeliveryLogItem {
  id: string;
  profileId: string;
  profileName: string;
  profileEmail: string;
  channel: string;
  status: string;
  sentAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  failureReason: string | null;
}

export interface AdDispatchEvent {
  day: string;         // "YYYY-MM-DD" UTC
  dispatchedAt: string; // ISO UTC timestamp of the first delivery in that batch
}

export interface AdAnalytics extends AdStats {
  dispatchEvents: AdDispatchEvent[];
  timeline: AdTimelinePoint[];
  deliveryLogs: AdDeliveryLogItem[];
}

export interface AdDashboardItem {
  id: string;
  title: string;
  status: string;
  channels: string[];
  startDate: Date;
  endDate: Date;
  stats: AdStats;
}

@Injectable()
export class AdAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private toRates(totalSent: number, totalOpened: number, totalClicks: number) {
    return {
      openRate: totalSent > 0 ? totalOpened / totalSent : 0,
      clickRate: totalSent > 0 ? totalClicks / totalSent : 0,
    };
  }

  private buildTimeline(
    deliveryLogs: Array<{
      sent_at: Date | null;
      clicked_at: Date | null;
      status: string;
    }>,
  ): AdTimelinePoint[] {
    const grouped = new Map<string, AdTimelinePoint>();

    for (const log of deliveryLogs) {
      if (!log.sent_at) continue;

      const date = log.sent_at.toISOString().slice(0, 10);
      const point = grouped.get(date) ?? { date, sent: 0, clicked: 0, failed: 0 };

      point.sent += 1;
      if (log.clicked_at) point.clicked += 1;
      if (log.status === 'FAILED') point.failed += 1;

      grouped.set(date, point);
    }

    return Array.from(grouped.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  async getStats(advertisementId: string): Promise<AdStats> {
    const ad = await this.prisma.advertisement.findUnique({
      where: { id: advertisementId },
    });
    if (!ad) throw new NotFoundException('Advertisement not found');
    const [deliveryLogs, links] = await Promise.all([
      this.prisma.adDeliveryLog.findMany({
        where: { advertisement_id: advertisementId },
        select: {
          status: true,
          opened_at: true,
          clicked_at: true,
        },
      }),
      this.prisma.adTrackedLink.findMany({
        where: { advertisement_id: advertisementId },
        select: {
          hash: true,
          original_url: true,
          click_count: true,
          last_clicked_at: true,
        },
        orderBy: [{ click_count: 'desc' }, { created_at: 'asc' }],
      }),
    ]);

    const successfulStatuses = new Set(['SENT', 'DELIVERED', 'OPENED', 'CLICKED']);
    const totalSent = deliveryLogs.filter((l) =>
      successfulStatuses.has(l.status),
    ).length;
    const totalOpened = deliveryLogs.filter((l) => l.opened_at != null).length;
    const clickedDeliveries = deliveryLogs.filter((l) => l.clicked_at != null).length;
    const totalClicks = links.reduce((sum, l) => sum + l.click_count, 0);
    const { openRate, clickRate } = this.toRates(totalSent, totalOpened, totalClicks);

    const now = new Date();
    const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

    return {
      totalSent,
      totalOpened,
      totalClicks,
      openRate,
      clickRate,
      clickedDeliveries,
      clickThroughRate: totalSent > 0 ? clickedDeliveries / totalSent : 0,
      remainingDays,
      links: links.map((l) => ({
        hash: l.hash,
        originalUrl: l.original_url,
        clickCount: l.click_count,
        lastClickedAt: l.last_clicked_at,
      })),
    };
  }

  async getAnalytics(advertisementId: string): Promise<AdAnalytics> {
    const ad = await this.prisma.advertisement.findUnique({
      where: { id: advertisementId },
    });
    if (!ad) throw new NotFoundException('Advertisement not found');

    const [links, deliveryLogs, dispatchEvents] = await Promise.all([
      this.prisma.adTrackedLink.findMany({
        where: { advertisement_id: advertisementId },
        select: {
          hash: true,
          original_url: true,
          click_count: true,
          last_clicked_at: true,
        },
        orderBy: [{ click_count: 'desc' }, { created_at: 'asc' }],
      }),
      this.prisma.adDeliveryLog.findMany({
        where: { advertisement_id: advertisementId },
        select: {
          id: true,
          profile_id: true,
          channel: true,
          status: true,
          sent_at: true,
          opened_at: true,
          clicked_at: true,
          failure_reason: true,
          profile: {
            select: {
              first_name: true,
              last_name: true,
              email: true,
            },
          },
        },
        orderBy: [{ sent_at: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.$queryRaw<{ day: string; dispatched_at: string }[]>`
        SELECT
          TO_CHAR(DATE_TRUNC('day', sent_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
          TO_CHAR(MIN(sent_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dispatched_at
        FROM "ad_delivery_logs"
        WHERE advertisement_id = ${advertisementId}::uuid
          AND status IN ('SENT', 'DELIVERED', 'OPENED', 'CLICKED')
          AND sent_at IS NOT NULL
        GROUP BY DATE_TRUNC('day', sent_at AT TIME ZONE 'UTC')
        ORDER BY 1
      `,
    ]);

    const successfulStatuses = new Set(['SENT', 'DELIVERED', 'OPENED', 'CLICKED']);
    const totalSent = deliveryLogs.filter((l) =>
      successfulStatuses.has(l.status),
    ).length;
    const totalOpened = deliveryLogs.filter((l) => l.opened_at != null).length;
    const clickedDeliveries = deliveryLogs.filter((l) => l.clicked_at != null).length;
    const totalClicks = links.reduce((sum, l) => sum + l.click_count, 0);
    const { openRate, clickRate } = this.toRates(totalSent, totalOpened, totalClicks);

    const now = new Date();
    const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

    return {
      totalSent,
      totalOpened,
      totalClicks,
      openRate,
      clickRate,
      clickedDeliveries,
      clickThroughRate: totalSent > 0 ? clickedDeliveries / totalSent : 0,
      remainingDays,
      links: links.map((l) => ({
        hash: l.hash,
        originalUrl: l.original_url,
        clickCount: l.click_count,
        lastClickedAt: l.last_clicked_at,
      })),
      dispatchEvents: dispatchEvents.map((e) => ({
        day: e.day,
        dispatchedAt: e.dispatched_at,
      })),
      timeline: this.buildTimeline(deliveryLogs),
      deliveryLogs: deliveryLogs.map((log) => ({
        id: log.id,
        profileId: log.profile_id,
        profileName:
          `${log.profile.first_name} ${log.profile.last_name}`.trim(),
        profileEmail: log.profile.email,
        channel: log.channel,
        status: log.status,
        sentAt: log.sent_at,
        openedAt: log.opened_at,
        clickedAt: log.clicked_at,
        failureReason: log.failure_reason,
      })),
    };
  }

  async getDashboard(): Promise<AdDashboardItem[]> {
    const ads = await this.prisma.advertisement.findMany({
      orderBy: { created_at: 'desc' },
      include: { bundle: true },
    });

    const now = new Date();

    return ads.map((ad) => {
      const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
      const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

      return {
        id: ad.id,
        title: ad.title,
        status: ad.status,
        channels: ad.bundle?.allowed_channels ?? [],
        startDate: ad.start_date,
        endDate: ad.end_date,
        stats: {
          totalSent: ad.total_sent,
          totalOpened: ad.total_opened,
          totalClicks: ad.total_clicks,
          openRate: ad.total_sent > 0 ? ad.total_opened / ad.total_sent : 0,
          clickRate: ad.total_sent > 0 ? ad.total_clicks / ad.total_sent : 0,
          clickedDeliveries: 0,
          clickThroughRate: 0,
          remainingDays,
          links: [],
        },
      };
    });
  }
}
