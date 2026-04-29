import { AdminApplicationController } from '../admin-application.controller';

function makeService() {
  return {
    getApplicationsForAdmin: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0 }),
    getApplicationDetailForAdmin: jest.fn().mockResolvedValue({ id: 'app1' }),
  };
}

describe('AdminApplicationController', () => {
  let controller: AdminApplicationController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new AdminApplicationController(service as any);
  });

  it('list() uses defaults and delegates', async () => {
    const result = await controller.list({} as any);
    expect(service.getApplicationsForAdmin).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      q: undefined,
      status: undefined,
      penaltyApplied: undefined,
    });
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('list() passes through dto values', async () => {
    await controller.list({
      page: 2,
      limit: 5,
      q: 'test',
      status: 'ACCEPTED',
      penalty_applied: true,
    } as any);
    expect(service.getApplicationsForAdmin).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      q: 'test',
      status: 'ACCEPTED',
      penaltyApplied: true,
    });
  });

  it('getById() delegates to service', async () => {
    const result = await controller.getById('app1');
    expect(service.getApplicationDetailForAdmin).toHaveBeenCalledWith('app1');
    expect(result).toEqual({ id: 'app1' });
  });
});
