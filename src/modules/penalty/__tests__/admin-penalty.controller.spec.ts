import { AdminPenaltyController } from '../admin-penalty.controller';

function makeService() {
  return {
    getPenaltiesForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    getPenaltyDetailForAdmin: jest.fn().mockResolvedValue({ id: 'pen1' }),
  };
}

const mockLogService = { create: jest.fn().mockResolvedValue(undefined) };

describe('AdminPenaltyController', () => {
  let controller: AdminPenaltyController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new AdminPenaltyController(
      service as any,
      mockLogService as any,
      { restore: jest.fn(), purge: jest.fn(), purgeBlockers: jest.fn() } as any,
    );
  });

  it('list() uses defaults and delegates', async () => {
    const result = await controller.list({} as any);
    expect(service.getPenaltiesForAdmin).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      q: undefined,
      paymentStatus: undefined,
    });
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('list() passes through dto values', async () => {
    await controller.list({
      page: 2,
      limit: 5,
      q: 'x',
      payment_status: 'PAID',
    } as any);
    expect(service.getPenaltiesForAdmin).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
      q: 'x',
      paymentStatus: 'PAID',
    });
  });

  it('getById() delegates to service', async () => {
    const result = await controller.getById('pen1');
    expect(service.getPenaltyDetailForAdmin).toHaveBeenCalledWith('pen1');
    expect(result).toEqual({ id: 'pen1' });
  });
});
