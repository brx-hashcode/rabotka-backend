import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryChannel } from '@prisma/client';
import { NotificationService } from '../../../notification/notification.service';
import { WhatsAppService } from '../../../whatsapp/whatsapp.service';
import { AdNotificationService } from '../ad-notification.service';

describe('AdNotificationService', () => {
  let service: AdNotificationService;
  let notificationService: jest.Mocked<NotificationService>;
  let whatsAppService: jest.Mocked<WhatsAppService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdNotificationService,
        {
          provide: NotificationService,
          useValue: { notifyAdvertisementCreated: jest.fn() },
        },
        {
          provide: WhatsAppService,
          useValue: {
            sendMediaMessage: jest.fn(),
            sendTextMessage: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AdNotificationService>(AdNotificationService);
    notificationService = module.get(NotificationService);
    whatsAppService = module.get(WhatsAppService);
  });

  it('sends email announcement with ad image payload', async () => {
    (
      notificationService.notifyAdvertisementCreated as jest.Mock
    ).mockResolvedValue(undefined);

    await service.dispatchCreated(
      { email: 'john@example.com', name: 'John Doe' },
      {
        advertisementId: 'ad-1',
        title: 'Offre',
        startDate: new Date('2026-04-17T00:00:00.000Z').toISOString(),
        endDate: new Date('2026-04-20T00:00:00.000Z').toISOString(),
        description: 'Description',
        ctaUrl: 'https://example.com/apply',
        callToAction: 'Plus de detail',
        imageUrl: 'https://cdn.example.com/ad.jpg',
      },
      DeliveryChannel.EMAIL,
    );

    expect(notificationService.notifyAdvertisementCreated).toHaveBeenCalledWith(
      {
        to: 'john@example.com',
        name: 'John Doe',
        title: 'Offre',
        startDate: expect.any(String),
        endDate: expect.any(String),
        description: 'Description',
        callToAction: 'Plus de detail',
        ctaUrl: 'https://example.com/apply',
        imageUrl: 'https://cdn.example.com/ad.jpg',
      },
    );
  });

  it('sends WhatsApp media and falls back to text when media fails', async () => {
    (whatsAppService.sendMediaMessage as jest.Mock).mockResolvedValue(false);
    (whatsAppService.sendTextMessage as jest.Mock).mockResolvedValue(true);

    await service.dispatchCreated(
      {
        email: 'john@example.com',
        phone: '+242055000000',
        name: 'John Doe',
      },
      {
        advertisementId: 'ad-1',
        title: 'Offre',
        startDate: new Date('2026-04-17T00:00:00.000Z').toISOString(),
        endDate: new Date('2026-04-20T00:00:00.000Z').toISOString(),
        description: 'Description',
        ctaUrl: 'https://example.com/apply',
        callToAction: 'Plus de detail',
        imageUrl: 'https://cdn.example.com/ad.jpg',
      },
      DeliveryChannel.WHATSAPP,
    );

    expect(whatsAppService.sendMediaMessage).toHaveBeenCalledWith(
      '+242055000000',
      'https://cdn.example.com/ad.jpg',
      expect.stringContaining('*Nouvelle annonce Rabotka*'),
    );
    expect(whatsAppService.sendTextMessage).toHaveBeenCalledWith(
      '+242055000000',
      expect.stringContaining("Pour plus d'informations"),
    );
  });

  it('dispatches to ALL channels (email + whatsapp)', async () => {
    (notificationService.notifyAdvertisementCreated as jest.Mock).mockResolvedValue(undefined);
    (whatsAppService.sendTextMessage as jest.Mock).mockResolvedValue(true);
    await service.dispatchCreated(
      { email: 'john@example.com', phone: '+242001', name: 'John' },
      { advertisementId: 'ad-1', title: 'Title', startDate: '2026-01-01', endDate: '2026-01-07' },
      DeliveryChannel.ALL,
    );
    expect(notificationService.notifyAdvertisementCreated).toHaveBeenCalled();
    expect(whatsAppService.sendTextMessage).toHaveBeenCalled();
  });

  it('skips whatsapp in ALL channel when no phone', async () => {
    (notificationService.notifyAdvertisementCreated as jest.Mock).mockResolvedValue(undefined);
    await service.dispatchCreated(
      { email: 'john@example.com', name: 'John' },
      { advertisementId: 'ad-1', title: 'Title', startDate: '2026-01-01', endDate: '2026-01-07' },
      DeliveryChannel.ALL,
    );
    expect(notificationService.notifyAdvertisementCreated).toHaveBeenCalled();
    expect(whatsAppService.sendTextMessage).not.toHaveBeenCalled();
  });

  describe('sendOnChannel', () => {
    const basePayload = {
      advertisementId: 'ad-1', title: 'Title', startDate: '2026-01-01', endDate: '2026-01-07',
    };

    it('sends email on EMAIL channel and returns true', async () => {
      (notificationService.notifyAdvertisementCreated as jest.Mock).mockResolvedValue(undefined);
      const result = await service.sendOnChannel({ email: 'a@test.com', name: 'Alice' }, basePayload, 'EMAIL');
      expect(result).toBe(true);
    });

    it('returns false when no email on EMAIL channel', async () => {
      const result = await service.sendOnChannel({ email: '', name: 'No Email' }, basePayload, 'EMAIL');
      expect(result).toBe(false);
    });

    it('returns false when no phone on WHATSAPP channel', async () => {
      const result = await service.sendOnChannel({ email: 'a@test.com', name: 'Alice' }, basePayload, 'WHATSAPP');
      expect(result).toBe(false);
    });

    it('sends media on WHATSAPP channel and returns true when imageUrl', async () => {
      (whatsAppService.sendMediaMessage as jest.Mock).mockResolvedValue(true);
      const result = await service.sendOnChannel(
        { email: 'a@test.com', phone: '+242001', name: 'Alice' },
        { ...basePayload, imageUrl: 'https://cdn.test/img.jpg' },
        'WHATSAPP',
      );
      expect(result).toBe(true);
    });

    it('falls back to text when media fails on WHATSAPP channel', async () => {
      (whatsAppService.sendMediaMessage as jest.Mock).mockResolvedValue(false);
      (whatsAppService.sendTextMessage as jest.Mock).mockResolvedValue(true);
      const result = await service.sendOnChannel(
        { email: 'a@test.com', phone: '+242001', name: 'Alice' },
        { ...basePayload, imageUrl: 'https://cdn.test/img.jpg' },
        'WHATSAPP',
      );
      expect(result).toBe(true);
    });

    it('sends text only on WHATSAPP when no imageUrl', async () => {
      (whatsAppService.sendTextMessage as jest.Mock).mockResolvedValue(true);
      const result = await service.sendOnChannel(
        { email: 'a@test.com', phone: '+242001', name: 'Alice' },
        { ...basePayload, tags: ['marketing', 'jobs'], ctaUrl: 'https://example.com', callToAction: 'Voir' },
        'WHATSAPP',
      );
      expect(result).toBe(true);
    });
  });
});
