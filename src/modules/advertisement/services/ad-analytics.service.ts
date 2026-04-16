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

export interface AdAnalytics extends AdStats {
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
    const [clickedDeliveries, links] = await Promise.all([
      this.prisma.adDeliveryLog.count({
        where: {
          advertisement_id: advertisementId,
          clicked_at: { not: null },
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

    const now = new Date();
    const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

    return {
      totalSent: ad.total_sent,
      totalOpened: ad.total_opened,
      totalClicks: ad.total_clicks,
      openRate: ad.total_sent > 0 ? ad.total_opened / ad.total_sent : 0,
      clickRate: ad.total_sent > 0 ? ad.total_clicks / ad.total_sent : 0,
      clickedDeliveries,
      clickThroughRate: ad.total_sent > 0 ? clickedDeliveries / ad.total_sent : 0,
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

    const [clickedDeliveries, links, deliveryLogs] = await Promise.all([
      this.prisma.adDeliveryLog.count({
        where: {
          advertisement_id: advertisementId,
          clicked_at: { not: null },
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
    ]);

    const now = new Date();
    const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

    return {
      totalSent: ad.total_sent,
      totalOpened: ad.total_opened,
      totalClicks: ad.total_clicks,
      openRate: ad.total_sent > 0 ? ad.total_opened / ad.total_sent : 0,
      clickRate: ad.total_sent > 0 ? ad.total_clicks / ad.total_sent : 0,
      clickedDeliveries,
      clickThroughRate: ad.total_sent > 0 ? clickedDeliveries / ad.total_sent : 0,
      remainingDays,
      links: links.map((l) => ({
        hash: l.hash,
        originalUrl: l.original_url,
        clickCount: l.click_count,
        lastClickedAt: l.last_clicked_at,
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
