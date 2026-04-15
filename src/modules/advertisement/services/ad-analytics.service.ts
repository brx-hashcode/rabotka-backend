import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

export interface AdStats {
  totalSent: number;
  totalOpened: number;
  totalClicks: number;
  openRate: number;
  clickRate: number;
  remainingDays: number;
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

    const now = new Date();
    const remainingMs = Math.max(0, ad.end_date.getTime() - now.getTime());
    const remainingDays = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

    return {
      totalSent: ad.total_sent,
      totalOpened: ad.total_opened,
      totalClicks: ad.total_clicks,
      openRate: ad.total_sent > 0 ? ad.total_opened / ad.total_sent : 0,
      clickRate: ad.total_sent > 0 ? ad.total_clicks / ad.total_sent : 0,
      remainingDays,
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
          remainingDays,
        },
      };
    });
  }
}
