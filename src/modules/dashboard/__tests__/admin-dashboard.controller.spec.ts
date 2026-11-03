import { AdminDashboardController } from '../admin-dashboard.controller';
import { TimeRange } from '../dto/job-activity-query.dto';

function makeService() {
  return {
    getMetrics: jest.fn().mockResolvedValue({ totalProfiles: 10 }),
    getJobActivity: jest
      .fn()
      .mockResolvedValue([{ date: '2026-01-01', created: 5, filled: 2 }]),
    refresh: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AdminDashboardController', () => {
  let controller: AdminDashboardController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new AdminDashboardController(service as any);
  });

  it('getMetrics() delegates to service', async () => {
    const result = await controller.getMetrics();
    expect(service.getMetrics).toHaveBeenCalled();
    expect(result).toEqual({ totalProfiles: 10 });
  });

  it('refresh() clears the cached figures through the service', async () => {
    await expect(controller.refresh()).resolves.toEqual({
      refreshedAt: expect.any(String),
    });
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });

  it('getJobActivity() uses provided range', async () => {
    const result = await controller.getJobActivity({
      range: TimeRange.THIRTY_DAYS,
    } as any);
    expect(service.getJobActivity).toHaveBeenCalledWith(TimeRange.THIRTY_DAYS);
    expect(result).toHaveLength(1);
  });

  it('getJobActivity() defaults to NINETY_DAYS when range not provided', async () => {
    await controller.getJobActivity({} as any);
    expect(service.getJobActivity).toHaveBeenCalledWith(TimeRange.NINETY_DAYS);
  });
});
