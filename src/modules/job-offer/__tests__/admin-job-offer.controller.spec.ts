import { AdminJobOfferController } from '../admin-job-offer.controller';

function makeService() {
  return {
    getJobOffersForAdmin: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    getJobOfferDetailForAdmin: jest.fn().mockResolvedValue({ id: 'jo1' }),
    updateJobOfferByAdmin: jest.fn().mockResolvedValue({ id: 'jo1' }),
    deleteJobOfferByAdmin: jest.fn().mockResolvedValue(undefined),
  };
}

const mockLogService = { create: jest.fn().mockResolvedValue(undefined) };

describe('AdminJobOfferController', () => {
  let controller: AdminJobOfferController;
  let service: ReturnType<typeof makeService>;

  beforeEach(() => {
    service = makeService();
    controller = new AdminJobOfferController(
      service as any,
      mockLogService as any,
    );
  });

  it('list() uses defaults and delegates', async () => {
    const result = await controller.list({} as any);
    expect(service.getJobOffersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 10 }),
    );
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('list() passes dto values', async () => {
    await controller.list({
      page: 2,
      limit: 5,
      q: 'plumber',
      status: 'PUBLISHED',
    } as any);
    expect(service.getJobOffersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 5,
        q: 'plumber',
        status: 'PUBLISHED',
      }),
    );
  });

  it('getById() delegates to service', async () => {
    const result = await controller.getById('jo1');
    expect(result).toEqual({ id: 'jo1' });
  });

  it('update() delegates to service', async () => {
    const result = await controller.update(
      'jo1',
      { title: 'New' } as any,
      {
        user: { userId: 'u1' },
        headers: {},
        ip: '127.0.0.1',
        get: () => undefined,
      } as any,
    );
    expect(service.updateJobOfferByAdmin).toHaveBeenCalledWith('jo1', {
      title: 'New',
    });
    expect(result).toEqual({ id: 'jo1' });
  });

  it('remove() calls deleteJobOfferByAdmin', async () => {
    await controller.remove('jo1', {
      user: { userId: 'u1' },
      headers: {},
      ip: '127.0.0.1',
      get: () => undefined,
    } as any);
    expect(service.deleteJobOfferByAdmin).toHaveBeenCalledWith('jo1');
  });
});
