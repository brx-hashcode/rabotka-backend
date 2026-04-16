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
