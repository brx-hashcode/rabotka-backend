import { Test, TestingModule } from '@nestjs/testing';
import { AdTrackingController } from '../ad-tracking.controller';
import { AdLinkTrackingService } from '../../services/ad-link-tracking.service';

const mockTracking = {
  resolveAndTrackClick: jest.fn().mockResolvedValue('https://example.com'),
};

describe('AdTrackingController', () => {
  let controller: AdTrackingController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdTrackingController],
      providers: [{ provide: AdLinkTrackingService, useValue: mockTracking }],
    }).compile();
    controller = module.get<AdTrackingController>(AdTrackingController);
  });

  it('redirect resolves hash and redirects', async () => {
    const req = {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      ip: '9.9.9.9',
      get: jest.fn().mockReturnValue('TestAgent/1.0'),
    } as any;
    const res = { redirect: jest.fn() } as any;

    await controller.redirect('abc123', req, res);

    expect(mockTracking.resolveAndTrackClick).toHaveBeenCalledWith('abc123', {
      ip: '1.2.3.4',
      userAgent: 'TestAgent/1.0',
    });
    expect(res.redirect).toHaveBeenCalledWith('https://example.com');
  });

  it('redirect uses req.ip when no forwarded header', async () => {
    const req = {
      headers: {},
      ip: '9.9.9.9',
      get: jest.fn().mockReturnValue(undefined),
    } as any;
    const res = { redirect: jest.fn() } as any;

    await controller.redirect('abc123', req, res);

    expect(mockTracking.resolveAndTrackClick).toHaveBeenCalledWith('abc123', {
      ip: '9.9.9.9',
      userAgent: undefined,
    });
  });
});
