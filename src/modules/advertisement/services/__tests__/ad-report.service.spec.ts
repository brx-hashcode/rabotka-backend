import { Test, TestingModule } from '@nestjs/testing';
import { AdReportService } from '../ad-report.service';
import { AdAnalyticsService } from '../ad-analytics.service';

const mockAnalyticsData = {
  totalSent: 10,
  totalOpened: 5,
  totalClicks: 2,
  openRate: 0.5,
  clickThroughRate: 0.2,
  timeline: [
    { date: '2026-01-01', sent: 5, clicked: 1, failed: 0 },
    { date: '2026-01-02', sent: 5, clicked: 1, failed: 1 },
  ],
  deliveryLogs: [
    {
      profileName: 'Alice',
      profileEmail: 'alice@test.com',
      channel: 'EMAIL',
      status: 'SENT',
      sentAt: new Date('2026-01-01'),
      openedAt: new Date('2026-01-02'),
      clickedAt: null,
    },
  ],
};

const mockStats = {
  totalSent: 10,
  delivered: 8,
  opened: 5,
  clicked: 2,
  failed: 1,
  openRate: 0.5,
  clickThroughRate: 0.2,
};

const mockAnalytics = {
  getStats: jest.fn().mockResolvedValue(mockStats),
  getAnalytics: jest.fn().mockResolvedValue(mockAnalyticsData),
};

describe('AdReportService', () => {
  let service: AdReportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdReportService,
        { provide: AdAnalyticsService, useValue: mockAnalytics },
      ],
    }).compile();
    service = module.get<AdReportService>(AdReportService);
  });

  it('getStats delegates to analytics service', async () => {
    const result = await service.getStats('ad-1');
    expect(mockAnalytics.getStats).toHaveBeenCalledWith('ad-1');
    expect(result).toEqual(mockStats);
  });

  it('getAnalytics delegates to analytics service', async () => {
    const result = await service.getAnalytics('ad-1');
    expect(mockAnalytics.getAnalytics).toHaveBeenCalledWith('ad-1');
    expect(result).toEqual(mockAnalyticsData);
  });

  it('generateExcel returns a Buffer', async () => {
    const buffer = await service.generateExcel('ad-1', 'Test Campaign');
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
