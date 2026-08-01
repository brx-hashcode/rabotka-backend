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
    assignment: {
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
    service = new DashboardService(prisma as any, {
      wrap: <T,>(_k: string, _t: number, loader: () => Promise<T>) => loader(),
      dashboardKey: (scope: string) => scope,
      listKey: (e: string) => e,
      invalidate: jest.fn(),
    } as never);
  });

  describe('getMetrics()', () => {
    it('returns metrics with zero values when db returns nulls', async () => {
      const metrics = await service.getMetrics();
      expect(metrics.profilesCount).toBe(0);
      expect(metrics.jobsCount).toBe(0);
      expect(metrics.applicationsCount).toBe(0);
      expect(metrics.assignmentsCount).toBe(0);
    });

    it('calculates trend as 100 when previous is 0 and current > 0', async () => {
      // Reset and setup for this test
      prisma = makePrisma();
      service = new DashboardService(prisma as any, {
      wrap: <T,>(_k: string, _t: number, loader: () => Promise<T>) => loader(),
      dashboardKey: (scope: string) => scope,
      listKey: (e: string) => e,
      invalidate: jest.fn(),
    } as never);

      // profile.count called 3 times: total, current 30d, previous 30d
      prisma.profile.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValueOnce(5) // current 30d
        .mockResolvedValueOnce(0); // previous 30d → calcTrend returns 100 when current > 0
      prisma.jobOffer.count.mockResolvedValue(0);
      prisma.application.count.mockResolvedValue(0);

      const metrics = await service.getMetrics();
      expect(metrics.profilesTrend).toBe(100);
    });

    it('calculates trend as null when both current and previous are 0', async () => {
      // Reset mocks for clean state
      prisma = makePrisma();
      service = new DashboardService(prisma as any, {
      wrap: <T,>(_k: string, _t: number, loader: () => Promise<T>) => loader(),
      dashboardKey: (scope: string) => scope,
      listKey: (e: string) => e,
      invalidate: jest.fn(),
    } as never);

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
