import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdAnalyticsService } from '../ad-analytics.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';

const now = new Date();
const futureDate = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

const mockAd = {
  id: 'ad-1',
  title: 'Test Ad',
  status: 'ACTIVE',
  start_date: now,
  end_date: futureDate,
  total_sent: 100,
  total_opened: 50,
  total_clicks: 20,
  bundle: { allowed_channels: ['WHATSAPP', 'EMAIL'] },
};

const mockDeliveryLogs = [
  {
    id: 'log-1',
    profile_id: 'p1',
    channel: 'WHATSAPP',
    status: 'SENT',
    sent_at: new Date('2026-06-01'),
    opened_at: new Date('2026-06-01'),
    clicked_at: null,
    failure_reason: null,
    profile: { first_name: 'Alice', last_name: 'Doe', email: 'alice@test.com' },
  },
  {
    id: 'log-2',
    profile_id: 'p2',
    channel: 'EMAIL',
    status: 'FAILED',
    sent_at: new Date('2026-06-02'),
    opened_at: null,
    clicked_at: null,
    failure_reason: 'Send error',
    profile: { first_name: 'Bob', last_name: 'Smith', email: 'bob@test.com' },
  },
  {
    id: 'log-3',
    profile_id: 'p3',
    channel: 'WHATSAPP',
    status: 'CLICKED',
    sent_at: new Date('2026-06-01'),
    opened_at: new Date('2026-06-01'),
    clicked_at: new Date('2026-06-01'),
    failure_reason: null,
    profile: { first_name: 'Charlie', last_name: 'Brown', email: 'c@test.com' },
  },
];

const mockLinks = [
  {
    hash: 'abc',
    original_url: 'https://example.com',
    click_count: 15,
    last_clicked_at: new Date(),
  },
];

const mockPrisma = {
  advertisement: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  adDeliveryLog: {
    findMany: jest.fn(),
  },
  adTrackedLink: {
    findMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

describe('AdAnalyticsService', () => {
  let service: AdAnalyticsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdAnalyticsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AdAnalyticsService>(AdAnalyticsService);
  });

  describe('getStats', () => {
    it('throws NotFoundException when ad not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValueOnce(null);
      await expect(service.getStats('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns stats for an advertisement', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValueOnce(mockAd);
      mockPrisma.adDeliveryLog.findMany.mockResolvedValueOnce([
        { status: 'SENT', opened_at: null, clicked_at: null },
        { status: 'FAILED', opened_at: null, clicked_at: null },
        { status: 'OPENED', opened_at: new Date(), clicked_at: null },
      ]);
      mockPrisma.adTrackedLink.findMany.mockResolvedValueOnce(mockLinks);

      const stats = await service.getStats('ad-1');
      expect(stats.totalSent).toBe(2); // SENT and OPENED both in successfulStatuses
      expect(stats.totalFailed).toBe(1);
      expect(stats.totalOpened).toBe(1);
      expect(stats.totalClicks).toBe(15);
      expect(stats.links).toHaveLength(1);
    });

    it('returns zero rates when no messages sent', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValueOnce(mockAd);
      mockPrisma.adDeliveryLog.findMany.mockResolvedValueOnce([]);
      mockPrisma.adTrackedLink.findMany.mockResolvedValueOnce([]);

      const stats = await service.getStats('ad-1');
      expect(stats.openRate).toBe(0);
      expect(stats.clickRate).toBe(0);
    });
  });

  describe('getAnalytics', () => {
    it('throws NotFoundException when ad not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValueOnce(null);
      await expect(service.getAnalytics('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns full analytics', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValueOnce(mockAd);
      mockPrisma.adTrackedLink.findMany.mockResolvedValueOnce(mockLinks);
      mockPrisma.adDeliveryLog.findMany.mockResolvedValueOnce(mockDeliveryLogs);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          { day: '2026-06-01', dispatched_at: '2026-06-01T10:00:00Z' },
        ]) // dispatchEvents
        .mockResolvedValueOnce([
          {
            total_sent: BigInt(2),
            total_opened: BigInt(1),
            clicked_deliveries: BigInt(1),
            total_failed: BigInt(1),
          },
        ]); // aggregates

      const analytics = await service.getAnalytics('ad-1');
      expect(analytics.totalSent).toBe(2);
      expect(analytics.totalOpened).toBe(1);
      expect(analytics.deliveryLogs).toHaveLength(3);
      expect(analytics.timeline.length).toBeGreaterThanOrEqual(1);
      expect(analytics.dispatchEvents).toHaveLength(1);
    });
  });

  describe('getDashboard', () => {
    it('returns dashboard items with stats', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValueOnce([mockAd]);
      const dashboard = await service.getDashboard();
      expect(dashboard).toHaveLength(1);
      expect(dashboard[0].id).toBe('ad-1');
      expect(dashboard[0].stats.totalSent).toBe(100);
      expect(dashboard[0].stats.openRate).toBe(0.5);
    });

    it('returns empty array when no ads', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValueOnce([]);
      const dashboard = await service.getDashboard();
      expect(dashboard).toEqual([]);
    });

    it('handles ad without bundle', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValueOnce([
        { ...mockAd, bundle: null },
      ]);
      const dashboard = await service.getDashboard();
      expect(dashboard[0].channels).toEqual([]);
    });
  });
});
