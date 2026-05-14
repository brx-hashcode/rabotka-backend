import { Test, TestingModule } from '@nestjs/testing';
import { AdAdminController } from '../ad-admin.controller';
import { AdvertisementService } from '../../services/advertisement.service';
import { AdAdminService } from '../../services/ad-admin.service';
import { AdAnalyticsService } from '../../services/ad-analytics.service';
import { AdminAuthGuard } from '../../../auth/guards/admin-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';

const mockAdvertisementService = {
  findAll: jest.fn().mockResolvedValue([]),
  create: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  findOne: jest.fn().mockResolvedValue({ id: 'ad-1', title: 'Test Ad' }),
  update: jest.fn().mockResolvedValue({ id: 'ad-1', title: 'Updated' }),
  confirmPayment: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  submit: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  pause: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  resume: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  cancel: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  delete: jest.fn().mockResolvedValue(undefined),
};

const mockAdAdminService = {
  listPendingReview: jest.fn().mockResolvedValue([]),
  getDashboard: jest.fn().mockResolvedValue({}),
  listBundles: jest.fn().mockResolvedValue([]),
  createBundle: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
  updateBundle: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
  deleteBundle: jest.fn().mockResolvedValue(undefined),
  approve: jest.fn().mockResolvedValue({ id: 'ad-1' }),
  reject: jest.fn().mockResolvedValue({ id: 'ad-1' }),
};

const mockAdAnalyticsService = {
  getDashboard: jest.fn().mockResolvedValue({ total: 0 }),
  getStats: jest.fn().mockResolvedValue({ totalSent: 0 }),
  getAnalytics: jest.fn().mockResolvedValue({ totalSent: 0, timeline: [] }),
};

describe('AdAdminController', () => {
  let controller: AdAdminController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdAdminController],
      providers: [
        { provide: AdvertisementService, useValue: mockAdvertisementService },
        { provide: AdAdminService, useValue: mockAdAdminService },
        { provide: AdAnalyticsService, useValue: mockAdAnalyticsService },
      ],
    })
      .overrideGuard(AdminAuthGuard).useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .compile();
    controller = module.get<AdAdminController>(AdAdminController);
  });

  it('findAll lists advertisements', async () => {
    const result = await controller.findAll({});
    expect(mockAdvertisementService.findAll).toHaveBeenCalledWith({});
    expect(result).toEqual([]);
  });

  it('create creates an advertisement', async () => {
    const dto = { title: 'New Ad', bundleId: 'bundle-1', startDate: '2026-07-01', endDate: '2026-07-31' } as any;
    const result = await controller.create(dto);
    expect(result.id).toBe('ad-1');
  });

  it('listPending returns pending ads', async () => {
    const result = await controller.listPending();
    expect(mockAdAdminService.listPendingReview).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('getDashboard returns analytics dashboard', async () => {
    const result = await controller.getDashboard();
    expect(mockAdAnalyticsService.getDashboard).toHaveBeenCalled();
    expect(result).toEqual({ total: 0 });
  });

  it('listBundles returns all bundles', async () => {
    const result = await controller.listBundles();
    expect(mockAdAdminService.listBundles).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('createBundle creates a bundle', async () => {
    const dto = { name: 'Bundle', priceXAF: 10000 } as any;
    const result = await controller.createBundle(dto);
    expect(result.id).toBe('bundle-1');
  });

  it('updateBundle updates a bundle', async () => {
    const dto = { name: 'Updated' } as any;
    const result = await controller.updateBundle('bundle-1', dto);
    expect(mockAdAdminService.updateBundle).toHaveBeenCalledWith('bundle-1', dto);
    expect(result.id).toBe('bundle-1');
  });

  it('deleteBundle deletes a bundle', async () => {
    await controller.deleteBundle('bundle-1');
    expect(mockAdAdminService.deleteBundle).toHaveBeenCalledWith('bundle-1');
  });

  it('findOne gets an advertisement by id', async () => {
    const result = await controller.findOne('ad-1');
    expect(result.id).toBe('ad-1');
  });

  it('update updates an advertisement', async () => {
    const result = await controller.update('ad-1', { title: 'Updated' } as any);
    expect(result.title).toBe('Updated');
  });

  it('confirmPayment confirms payment', async () => {
    const result = await controller.confirmPayment('ad-1');
    expect(mockAdvertisementService.confirmPayment).toHaveBeenCalledWith('ad-1');
  });

  it('submit submits an ad for review', async () => {
    const result = await controller.submit('ad-1');
    expect(mockAdvertisementService.submit).toHaveBeenCalledWith('ad-1');
  });

  it('approve approves an advertisement', async () => {
    const result = await controller.approve('ad-1');
    expect(mockAdAdminService.approve).toHaveBeenCalledWith('ad-1');
  });

  it('reject rejects an advertisement', async () => {
    const result = await controller.reject('ad-1', { reason: 'Bad content' });
    expect(mockAdAdminService.reject).toHaveBeenCalledWith('ad-1', 'Bad content');
  });

  it('pause pauses an advertisement', async () => {
    await controller.pause('ad-1');
    expect(mockAdvertisementService.pause).toHaveBeenCalledWith('ad-1');
  });

  it('resume resumes an advertisement', async () => {
    await controller.resume('ad-1');
    expect(mockAdvertisementService.resume).toHaveBeenCalledWith('ad-1');
  });

  it('cancel cancels an advertisement', async () => {
    await controller.cancel('ad-1');
    expect(mockAdvertisementService.cancel).toHaveBeenCalledWith('ad-1');
  });

  it('remove deletes an advertisement', async () => {
    await controller.remove('ad-1');
    expect(mockAdvertisementService.delete).toHaveBeenCalledWith('ad-1');
  });

  it('getStats returns ad stats', async () => {
    const result = await controller.getStats('ad-1');
    expect(mockAdAnalyticsService.getStats).toHaveBeenCalledWith('ad-1');
    expect(result).toEqual({ totalSent: 0 });
  });

  it('getAnalytics returns ad analytics', async () => {
    const result = await controller.getAnalytics('ad-1');
    expect(mockAdAnalyticsService.getAnalytics).toHaveBeenCalledWith('ad-1');
  });
});
