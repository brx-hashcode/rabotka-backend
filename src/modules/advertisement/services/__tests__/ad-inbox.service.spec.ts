import { Test, TestingModule } from '@nestjs/testing';
import { AdDeliveryStatus, AdStatus, DeliveryChannel } from '@prisma/client';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdInboxService } from '../ad-inbox.service';
import { AdLinkTrackingService } from '../ad-link-tracking.service';

const makeLog = (overrides: Record<string, unknown> = {}) => ({
  id: 'dl-1',
  advertisement: {
    id: 'ad-1',
    title: 'Promo pizza',
    description: 'Deux pour une',
    image_urls: ['https://cdn.example.com/ad.jpg'],
    banner_url: null,
    call_to_action: 'Commander',
    cta_url: 'https://example.com/promo',
    tags: ['nettoyage', 'promo'],
  },
  tracked_links: [{ hash: 'abc123' }],
  ...overrides,
});

describe('AdInboxService', () => {
  let service: AdInboxService;
  let prisma: any;

  beforeEach(async () => {
    const mockPrismaService = {
      adDeliveryLog: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue({ advertisement_id: 'ad-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      advertisement: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdInboxService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: AdLinkTrackingService,
          useValue: {
            buildTrackedUrl: jest
              .fn()
              .mockImplementation((hash: string) => `https://app.test/r/${hash}`),
          },
        },
      ],
    }).compile();

    service = module.get<AdInboxService>(AdInboxService);
    prisma = module.get(PrismaService);
  });

  describe('listPending()', () => {
    it('only returns unopened IN_APP deliveries of running ads', async () => {
      await service.listPending('profile-1');

      const where = prisma.adDeliveryLog.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        profile_id: 'profile-1',
        channel: DeliveryChannel.IN_APP,
        status: AdDeliveryStatus.SENT,
        opened_at: null,
        advertisement: { status: AdStatus.ACTIVE },
      });
      expect(where.advertisement.end_date.gte).toBeInstanceOf(Date);
    });

    it('maps a delivery to a popup payload with the tracked CTA', async () => {
      prisma.adDeliveryLog.findMany.mockResolvedValue([makeLog()]);

      const [ad] = await service.listPending('profile-1');

      expect(ad).toEqual({
        deliveryId: 'dl-1',
        advertisementId: 'ad-1',
        title: 'Promo pizza',
        description: 'Deux pour une',
        imageUrl: 'https://cdn.example.com/ad.jpg',
        callToAction: 'Commander',
        ctaUrl: 'https://app.test/r/abc123',
        tags: ['nettoyage', 'promo'],
      });
    });

    it('prefers the banner over the first image', async () => {
      prisma.adDeliveryLog.findMany.mockResolvedValue([
        makeLog({
          advertisement: {
            ...makeLog().advertisement,
            banner_url: 'https://cdn.example.com/banner.jpg',
          },
        }),
      ]);

      const [ad] = await service.listPending('profile-1');

      expect(ad.imageUrl).toBe('https://cdn.example.com/banner.jpg');
    });

    it('falls back to the raw cta_url when no link was tracked', async () => {
      prisma.adDeliveryLog.findMany.mockResolvedValue([
        makeLog({ tracked_links: [] }),
      ]);

      const [ad] = await service.listPending('profile-1');

      expect(ad.ctaUrl).toBe('https://example.com/promo');
    });

    it('returns null imageUrl when the ad has no visual', async () => {
      prisma.adDeliveryLog.findMany.mockResolvedValue([
        makeLog({
          advertisement: {
            ...makeLog().advertisement,
            image_urls: [],
            banner_url: null,
          },
        }),
      ]);

      const [ad] = await service.listPending('profile-1');

      expect(ad.imageUrl).toBeNull();
    });
  });

  describe('markSeen()', () => {
    it('scopes the dismissal to the owning profile', async () => {
      await service.markSeen('profile-1', 'dl-1');

      expect(prisma.adDeliveryLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'dl-1',
          profile_id: 'profile-1',
          channel: DeliveryChannel.IN_APP,
          opened_at: null,
        },
        data: { opened_at: expect.any(Date) },
      });
    });

    it('increments total_opened on first dismissal', async () => {
      await service.markSeen('profile-1', 'dl-1');

      expect(prisma.advertisement.update).toHaveBeenCalledWith({
        where: { id: 'ad-1' },
        data: { total_opened: { increment: 1 } },
      });
    });

    it('is a no-op when the delivery was already seen', async () => {
      prisma.adDeliveryLog.updateMany.mockResolvedValue({ count: 0 });

      await service.markSeen('profile-1', 'dl-1');

      expect(prisma.advertisement.update).not.toHaveBeenCalled();
    });

    it('does not throw when the counter bump fails', async () => {
      prisma.advertisement.update.mockRejectedValue(new Error('db down'));

      await expect(service.markSeen('profile-1', 'dl-1')).resolves.toBeUndefined();
    });
  });
});
