import { Test, TestingModule } from '@nestjs/testing';
import { AdDeliveryStatus, AdStatus, DeliveryChannel } from '@prisma/client';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdTargetingService } from '../ad-targeting.service';
import { AdProcessor } from '../ad.processor';
import { AdLinkTrackingService } from '../ad-link-tracking.service';
import { AdNotificationService } from '../ad-notification.service';

describe('AdProcessor', () => {
  let service: AdProcessor;
  let prisma: jest.Mocked<PrismaService>;
  let adTargeting: jest.Mocked<AdTargetingService>;
  let adLinkTracking: jest.Mocked<AdLinkTrackingService>;
  let adNotificationService: jest.Mocked<AdNotificationService>;

  beforeEach(async () => {
    const mockPrismaService = {
      advertisement: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      adDeliveryLog: {
        count: jest.fn(),
        create: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdProcessor,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AdTargetingService, useValue: { resolveRecipients: jest.fn() } },
        { provide: AdLinkTrackingService, useValue: { buildTrackedPayload: jest.fn() } },
        { provide: AdNotificationService, useValue: { dispatchCreated: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdProcessor>(AdProcessor);
    prisma = module.get(PrismaService);
    adTargeting = module.get(AdTargetingService);
    adLinkTracking = module.get(AdLinkTrackingService);
    adNotificationService = module.get(AdNotificationService);
  });

  it('dispatches ad notifications via ad notification service with image payload', async () => {
    const start = new Date('2026-04-01T08:00:00.000Z');
    const end = new Date('2026-04-30T08:00:00.000Z');

    (prisma.advertisement.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'ad-1',
        title: 'OFFRE D’EMPLOI : CHARGE DES APPLICATIONS',
        description: 'Description de test',
        call_to_action: 'plus de detail',
        cta_url: 'https://example.com/apply',
        start_date: start,
        end_date: end,
        image_urls: ['https://cdn.example.com/ad.jpg'],
        status: AdStatus.ACTIVE,
        bundle: {
          allowed_channels: [DeliveryChannel.EMAIL],
          max_reach: 100,
          max_frequency_per_week: 3,
        },
      },
    ]);
    (prisma.adDeliveryLog.count as jest.Mock).mockResolvedValue(0);
    (adTargeting.resolveRecipients as jest.Mock).mockResolvedValue([
      {
        id: 'profile-1',
        first_name: 'John',
        last_name: 'Doe',
        email: 'john@example.com',
        phone: '+242055000000',
      },
    ]);
    (prisma.adDeliveryLog.create as jest.Mock).mockResolvedValue({ id: 'dl-1' });
    (adLinkTracking.buildTrackedPayload as jest.Mock).mockImplementation(
      async ({ payload }) => ({
        ...payload,
        ctaUrl: 'https://app.rabotka.co/r/tracked',
      }),
    );
    (adNotificationService.dispatchCreated as jest.Mock).mockResolvedValue(undefined);
    (prisma.advertisement.update as jest.Mock).mockResolvedValue({});

    await service.process({ data: { type: 'dispatch' } });

    expect(prisma.adDeliveryLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        advertisement_id: 'ad-1',
        profile_id: 'profile-1',
        channel: DeliveryChannel.EMAIL,
        status: AdDeliveryStatus.SENT,
      }),
    });
    expect(adNotificationService.dispatchCreated).toHaveBeenCalledWith(
      {
        email: 'john@example.com',
        phone: '+242055000000',
        name: 'John Doe',
      },
      expect.objectContaining({
        advertisementId: 'ad-1',
        ctaUrl: 'https://app.rabotka.co/r/tracked',
        imageUrl: 'https://cdn.example.com/ad.jpg',
      }),
      DeliveryChannel.EMAIL,
    );
    expect(prisma.advertisement.update).toHaveBeenCalledWith({
      where: { id: 'ad-1' },
      data: { total_sent: { increment: 1 } },
    });
  });
});
