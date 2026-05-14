import { Test, TestingModule } from '@nestjs/testing';
import { AdDeliveryStatus, AdStatus, DeliveryChannel } from '@prisma/client';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdTargetingService } from '../ad-targeting.service';
import { AdProcessor } from '../ad.processor';
import { AdLinkTrackingService } from '../ad-link-tracking.service';
import { AdNotificationService } from '../ad-notification.service';
import { AdReportService } from '../ad-report.service';
import { NotificationService } from '../../../notification/notification.service';

const makeAd = (overrides: Record<string, unknown> = {}) => ({
  id: 'ad-1',
  title: 'Test Ad',
  description: 'Description',
  call_to_action: 'Click',
  cta_url: 'https://example.com',
  start_date: new Date('2026-01-01T00:00:00Z'),
  end_date: new Date('2026-12-31T00:00:00Z'),
  dispatch_time: '00:00',
  image_urls: ['https://cdn.example.com/ad.jpg'],
  tags: null,
  status: AdStatus.ACTIVE,
  bundle: {
    allowed_channels: [DeliveryChannel.EMAIL],
    max_reach: 100,
    max_frequency_per_week: 3,
  },
  ...overrides,
});

const makeProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'profile-1',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@example.com',
  phone: '+242055000000',
  whatsapp_connected: false,
  ...overrides,
});

describe('AdProcessor', () => {
  let service: AdProcessor;
  let prisma: any;
  let adTargeting: jest.Mocked<AdTargetingService>;
  let adLinkTracking: jest.Mocked<AdLinkTrackingService>;
  let adNotificationService: jest.Mocked<AdNotificationService>;
  let adReport: any;
  let notificationService: any;

  beforeEach(async () => {
    const mockPrismaService = {
      advertisement: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      adDeliveryLog: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'dl-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdProcessor,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AdTargetingService, useValue: { resolveRecipients: jest.fn().mockResolvedValue([]) } },
        { provide: AdLinkTrackingService, useValue: { buildTrackedPayload: jest.fn().mockImplementation(async ({ payload }) => payload) } },
        { provide: AdNotificationService, useValue: { dispatchCreated: jest.fn(), sendOnChannel: jest.fn().mockResolvedValue(true) } },
        { provide: AdReportService, useValue: { generateExcel: jest.fn().mockResolvedValue(Buffer.from('xlsx')), getAnalytics: jest.fn().mockResolvedValue({ timeline: [] }) } },
        { provide: NotificationService, useValue: { notifyAdvertisementCompleted: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<AdProcessor>(AdProcessor);
    prisma = module.get(PrismaService);
    adTargeting = module.get(AdTargetingService);
    adLinkTracking = module.get(AdLinkTrackingService);
    adNotificationService = module.get(AdNotificationService);
    adReport = module.get(AdReportService);
    notificationService = module.get(NotificationService);
  });

  describe('process()', () => {
    it('calls runLifecycle for type=lifecycle', async () => {
      prisma.advertisement.updateMany.mockResolvedValue({ count: 0 });
      await service.process({ data: { type: 'lifecycle' } });
      expect(prisma.advertisement.updateMany).toHaveBeenCalledTimes(2);
    });

    it('calls runDispatch for type=dispatch', async () => {
      prisma.advertisement.findMany.mockResolvedValue([]);
      await service.process({ data: { type: 'dispatch' } });
      expect(prisma.advertisement.findMany).toHaveBeenCalled();
    });

    it('logs warn for unknown type', async () => {
      // Should not throw for unknown type
      await expect(service.process({ data: { type: 'unknown' as any } })).resolves.not.toThrow();
    });
  });

  describe('runLifecycle()', () => {
    it('activates APPROVED ads and completes ACTIVE expired ads', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 2 }) // activated
        .mockResolvedValueOnce({ count: 3 }); // completed
      prisma.advertisement.findMany.mockResolvedValue([]);

      await service.process({ data: { type: 'lifecycle' } });

      expect(prisma.advertisement.updateMany).toHaveBeenCalledTimes(2);
    });

    it('does not call sendCompletionReports when completed.count = 0', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 1 }) // activated
        .mockResolvedValueOnce({ count: 0 }); // completed=0

      await service.process({ data: { type: 'lifecycle' } });

      expect(prisma.advertisement.findMany).not.toHaveBeenCalled();
    });

    it('calls sendCompletionReports when completed.count > 0', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.advertisement.findMany.mockResolvedValue([]);

      await service.process({ data: { type: 'lifecycle' } });

      expect(prisma.advertisement.findMany).toHaveBeenCalled();
    });
  });

  describe('sendCompletionReports()', () => {
    it('skips ads with no contact_email', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.advertisement.findMany.mockResolvedValue([
        { id: 'ad-1', title: 'Test', contact_email: null, start_date: new Date(), end_date: new Date() },
      ]);

      await service.process({ data: { type: 'lifecycle' } });

      expect(notificationService.notifyAdvertisementCompleted).not.toHaveBeenCalled();
    });

    it('sends completion report for ads with contact_email', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.advertisement.findMany.mockResolvedValue([
        {
          id: 'ad-1',
          title: 'Test Ad',
          contact_email: 'advertiser@example.com',
          start_date: new Date('2026-01-01T00:00:00Z'),
          end_date: new Date('2026-03-01T00:00:00Z'),
        },
      ]);

      await service.process({ data: { type: 'lifecycle' } });

      expect(notificationService.notifyAdvertisementCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'advertiser@example.com', adTitle: 'Test Ad' }),
      );
    });

    it('handles report generation failure gracefully', async () => {
      prisma.advertisement.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.advertisement.findMany.mockResolvedValue([
        {
          id: 'ad-1',
          title: 'Test Ad',
          contact_email: 'advertiser@example.com',
          start_date: new Date(),
          end_date: new Date(),
        },
      ]);
      adReport.generateExcel.mockRejectedValueOnce(new Error('Excel failure'));

      await expect(service.process({ data: { type: 'lifecycle' } })).resolves.not.toThrow();
      expect(notificationService.notifyAdvertisementCompleted).not.toHaveBeenCalled();
    });
  });

  describe('runDispatch()', () => {
    it('activates APPROVED ads before dispatch', async () => {
      prisma.advertisement.updateMany.mockResolvedValue({ count: 2 });
      prisma.advertisement.findMany.mockResolvedValue([]);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.advertisement.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: AdStatus.ACTIVE } }),
      );
    });

    it('skips ads where isDispatchDue returns false (already sent today)', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd({ dispatch_time: '23:59' })]);
      // sentToday > 0 means dispatch is not due
      prisma.adDeliveryLog.count.mockResolvedValueOnce(1);

      await service.process({ data: { type: 'dispatch' } });

      expect(adTargeting.resolveRecipients).not.toHaveBeenCalled();
    });

    it('handles dispatchAd error gracefully', async () => {
      const ad = makeAd();
      prisma.advertisement.findMany.mockResolvedValue([ad]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]); // 0 batches dispatched so far → due
      adTargeting.resolveRecipients.mockRejectedValueOnce(new Error('targeting failed'));

      await expect(service.process({ data: { type: 'dispatch' } })).resolves.not.toThrow();
    });
  });

  describe('dispatchAd()', () => {
    it('skips when bundle has no allowed channels', async () => {
      const ad = makeAd({ bundle: { allowed_channels: [], max_reach: 10, max_frequency_per_week: 1, target_audience: 'ALL' } });
      prisma.advertisement.findMany.mockResolvedValue([ad]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.process({ data: { type: 'dispatch' } });

      expect(adTargeting.resolveRecipients).not.toHaveBeenCalled();
    });

    it('skips when no recipients found', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([]);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.adDeliveryLog.create).not.toHaveBeenCalled();
    });

    it('dispatches via EMAIL channel', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);

      await service.process({ data: { type: 'dispatch' } });

      expect(adNotificationService.sendOnChannel).toHaveBeenCalled();
    });

    it('skips profile with no deliverable channel (email missing, no whatsapp)', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      // email='' → EMAIL not deliverable
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile({ email: '', whatsapp_connected: false })]);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.adDeliveryLog.create).not.toHaveBeenCalled();
    });

    it('dispatches via WHATSAPP when profile has phone and whatsapp_connected', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        makeAd({ bundle: { allowed_channels: [DeliveryChannel.WHATSAPP], max_reach: 10, max_frequency_per_week: 3, target_audience: 'ALL' } }),
      ]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile({ whatsapp_connected: true })]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);

      await service.process({ data: { type: 'dispatch' } });

      expect(adNotificationService.sendOnChannel).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'WHATSAPP',
      );
    });

    it('dispatches via ALL channels (EMAIL + WHATSAPP)', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        makeAd({ bundle: { allowed_channels: [DeliveryChannel.ALL], max_reach: 10, max_frequency_per_week: 3, target_audience: 'ALL' } }),
      ]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile({ whatsapp_connected: true })]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);

      await service.process({ data: { type: 'dispatch' } });

      expect(adNotificationService.sendOnChannel).toHaveBeenCalledTimes(2);
    });

    it('handles sendOnChannel returning false → result=failed', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);
      adNotificationService.sendOnChannel.mockResolvedValueOnce(false);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.adDeliveryLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ failure_reason: 'CARRIER_REJECTED' }) }),
      );
    });

    it('handles sendOnChannel throwing → result=failed', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);
      adLinkTracking.buildTrackedPayload.mockRejectedValueOnce(new Error('link error'));

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.adDeliveryLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ failure_reason: expect.stringContaining('link error') }) }),
      );
    });

    it('handles sendOnChannel throwing non-Error → UNKNOWN reason', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);
      adLinkTracking.buildTrackedPayload.mockRejectedValueOnce('string error');

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.adDeliveryLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ failure_reason: 'UNKNOWN' }) }),
      );
    });

    it('updates total_sent after successful sends', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count
        .mockResolvedValueOnce(0) // sentToday → isDispatchDue
        .mockResolvedValueOnce(5); // totalDelivered after dispatch
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);
      adNotificationService.sendOnChannel.mockResolvedValue(true);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.advertisement.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { total_sent: 5 } }),
      );
    });

    it('does not update total_sent when sentCount = 0', async () => {
      prisma.advertisement.findMany.mockResolvedValue([makeAd()]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      // Profile with no deliverable channels
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile({ email: '', whatsapp_connected: false })]);

      await service.process({ data: { type: 'dispatch' } });

      expect(prisma.advertisement.update).not.toHaveBeenCalled();
    });

    it('ad with null cta_url and image_urls uses null fallback', async () => {
      prisma.advertisement.findMany.mockResolvedValue([
        makeAd({ cta_url: null, call_to_action: null, image_urls: null }),
      ]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      prisma.$queryRaw.mockResolvedValue([]);
      adTargeting.resolveRecipients.mockResolvedValue([makeProfile()]);

      await service.process({ data: { type: 'dispatch' } });

      expect(adNotificationService.sendOnChannel).toHaveBeenCalled();
    });
  });

  describe('isDispatchDue()', () => {
    it('returns false if dispatch time is in the future', async () => {
      const ad = makeAd({ dispatch_time: '23:59' });
      prisma.advertisement.findMany.mockResolvedValue([ad]);
      prisma.adDeliveryLog.count.mockResolvedValue(0);
      // Don't need to check $queryRaw as it returns false before that

      await service.process({ data: { type: 'dispatch' } });
      // If dispatch not due, resolveRecipients is not called
      expect(adTargeting.resolveRecipients).not.toHaveBeenCalled();
    });

    it('returns false if already sent today (sentToday > 0)', async () => {
      const ad = makeAd({ dispatch_time: '00:00' });
      prisma.advertisement.findMany.mockResolvedValue([ad]);
      prisma.adDeliveryLog.count.mockResolvedValueOnce(1); // sentToday > 0

      await service.process({ data: { type: 'dispatch' } });

      expect(adTargeting.resolveRecipients).not.toHaveBeenCalled();
    });

    it('returns true if actualBatches < expectedBatches', async () => {
      const ad = makeAd({ dispatch_time: '00:00', start_date: new Date('2026-01-01T00:00:00Z') });
      prisma.advertisement.findMany.mockResolvedValue([ad]);
      prisma.adDeliveryLog.count.mockResolvedValue(0); // sentToday = 0
      prisma.$queryRaw.mockResolvedValue([]); // actualBatches = 0, expectedBatches >= 1
      adTargeting.resolveRecipients.mockResolvedValue([]);

      await service.process({ data: { type: 'dispatch' } });

      expect(adTargeting.resolveRecipients).toHaveBeenCalled();
    });
  });
});
