import { DashboardService } from '../dashboard.service';
import { TimeRange } from '../dto/job-activity-query.dto';

function makePrisma() {
  return {
    payment: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
    },
    profile: {
      count: jest.fn().mockResolvedValue(0),
    },
    jobOffer: {
      count: jest.fn().mockResolvedValue(0),
    },
    application: {
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe('DashboardService', () => {
  let service: DashboardService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new DashboardService(prisma as any);
  });

  describe('getMetrics()', () => {
    it('returns metrics with zero values when db returns nulls', async () => {
      const metrics = await service.getMetrics();
      expect(metrics.revenue).toBe(0);
      expect(metrics.profilesCount).toBe(0);
      expect(metrics.jobsCount).toBe(0);
      expect(metrics.applicationsCount).toBe(0);
    });

    it('calculates revenue from total sum', async () => {
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 50000 } });
      const metrics = await service.getMetrics();
      expect(metrics.revenue).toBe(50000);
    });

    it('calculates trend as null when previous is 0', async () => {
      // Reset and setup for this test
      prisma = makePrisma();
      service = new DashboardService(prisma as any);

      // payment.aggregate is called 3 times, profile.count 3 times, jobOffer.count 3 times, application.count 3 times
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: null } });
      prisma.profile.count
        .mockResolvedValueOnce(5)  // total
        .mockResolvedValueOnce(5)  // current 30d
        .mockResolvedValueOnce(0); // previous 30d (calcTrend returns null when previous is 0)
      prisma.jobOffer.count.mockResolvedValue(0);
      prisma.application.count.mockResolvedValue(0);

      const metrics = await service.getMetrics();
      expect(metrics.profilesTrend).toBeNull();
    });

    it('calculates trend as null when both current and previous are 0', async () => {
      // Reset mocks for clean state
      prisma = makePrisma();
      service = new DashboardService(prisma as any);

      const metrics = await service.getMetrics();
      expect(metrics.profilesTrend).toBeNull(); // previous is 0, so trend is null
    });

    it('calculates trend percentage correctly', async () => {
      // jobs: total=10, current=6, previous=4 → (6-4)/4 * 100 = 50
      prisma.jobOffer.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(4);
      const metrics = await service.getMetrics();
      expect(metrics.jobsTrend).toBe(50);
    });
  });

  describe('getJobActivity()', () => {
    it('returns empty array when no data', async () => {
      const result = await service.getJobActivity(TimeRange.SEVEN_DAYS);
      expect(result).toEqual([]);
    });

    it('maps raw rows to date/jobCreated/jobFilled', async () => {
      const date = new Date('2026-03-01T00:00:00Z');
      prisma.$queryRaw.mockResolvedValue([
        { date, job_created: BigInt(3), job_filled: BigInt(1) },
      ]);
      const result = await service.getJobActivity(TimeRange.THIRTY_DAYS);
      expect(result).toHaveLength(1);
      expect(result[0].jobCreated).toBe(3);
      expect(result[0].jobFilled).toBe(1);
      expect(result[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('supports all time ranges', async () => {
      for (const range of Object.values(TimeRange)) {
        await expect(service.getJobActivity(range)).resolves.toBeDefined();
      }
    });
  });
});
