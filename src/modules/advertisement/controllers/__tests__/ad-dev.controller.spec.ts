import { Test, TestingModule } from '@nestjs/testing';
import { AdDevController } from '../ad-dev.controller';
import { AdvertisementService } from '../../services/advertisement.service';
import { AdReportService } from '../../services/ad-report.service';
import { NotificationService } from '../../../notification/notification.service';

const mockAd = {
  id: 'ad-1',
  title: 'Test Ad',
  start_date: new Date('2026-06-01'),
  end_date: new Date('2026-06-30'),
};

const mockAdvertisementService = {
  findOne: jest.fn().mockResolvedValue(mockAd),
};

const mockAdReportService = {
  generateExcel: jest.fn().mockResolvedValue(Buffer.from('excel')),
  getAnalytics: jest.fn().mockResolvedValue({ totalSent: 10, timeline: [] }),
};

const mockNotificationService = {
  notifyAdvertisementCompleted: jest.fn().mockResolvedValue(undefined),
};

describe('AdDevController', () => {
  let controller: AdDevController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdDevController],
      providers: [
        { provide: AdvertisementService, useValue: mockAdvertisementService },
        { provide: AdReportService, useValue: mockAdReportService },
        { provide: NotificationService, useValue: mockNotificationService },
      ],
    }).compile();
    controller = module.get<AdDevController>(AdDevController);
  });

  it('sendTestReport sends a test report and returns info', async () => {
    const result = await controller.sendTestReport('ad-1');
    expect(mockAdvertisementService.findOne).toHaveBeenCalledWith('ad-1');
    expect(mockAdReportService.generateExcel).toHaveBeenCalledWith(
      'ad-1',
      'Test Ad',
    );
    expect(mockAdReportService.getAnalytics).toHaveBeenCalledWith('ad-1');
    expect(
      mockNotificationService.notifyAdvertisementCompleted,
    ).toHaveBeenCalled();
    expect(result.sent).toBe(true);
    expect(result.adTitle).toBe('Test Ad');
  });
});
