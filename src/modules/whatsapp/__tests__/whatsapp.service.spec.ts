import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { WhatsAppService } from '../whatsapp.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { TwilioService } from '../../../common/services/twilio/twilio.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

// Prevent the real Twilio SDK from being loaded in this test suite
jest.mock('twilio', () => {
  const factory = jest.fn().mockReturnValue({ messages: { create: jest.fn() } });
  (factory as unknown as Record<string, unknown>).validateRequest = jest.fn().mockReturnValue(true);
  return factory;
});

const PROFILE_ID = 'profile-uuid-1';
const PHONE = '+24200000001';

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let prisma: jest.Mocked<PrismaService>;
  let twilioService: jest.Mocked<TwilioService>;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const mockPrismaService = {
      message: { create: jest.fn().mockResolvedValue({}) },
      profile: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const mockTwilioService = {
      sendWhatsApp: jest.fn().mockResolvedValue('SM-sid'),
      sendWhatsAppMedia: jest.fn().mockResolvedValue('SM-media-sid'),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TwilioService, useValue: mockTwilioService },
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<WhatsAppService>(WhatsAppService);
    prisma = module.get(PrismaService);
    twilioService = module.get(TwilioService);
  });

  describe('isConfigured()', () => {
    it('delegates to twilioService.isConfigured', () => {
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('sendTextMessage()', () => {
    it('sends text and returns true when SID is returned', async () => {
      const result = await service.sendTextMessage(PHONE, 'Hello');
      expect(result).toBe(true);
      expect(twilioService.sendWhatsApp).toHaveBeenCalledWith(PHONE, 'Hello');
    });

    it('saves outbound message when profileId is provided', async () => {
      await service.sendTextMessage(PHONE, 'Hello', PROFILE_ID);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          profile_id: PROFILE_ID,
          direction: MessageDirection.OUTBOUND,
          body: 'Hello',
          platform: BotPlatform.WHATSAPP,
        }),
      });
    });

    it('does not save message when no profileId', async () => {
      await service.sendTextMessage(PHONE, 'Hello');
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('returns false when twilio returns null', async () => {
      (twilioService.sendWhatsApp as jest.Mock).mockResolvedValue(null);

      const result = await service.sendTextMessage(PHONE, 'Hello');
      expect(result).toBe(false);
    });
  });

  describe('sendMediaMessage()', () => {
    it('sends media message and returns true', async () => {
      const result = await service.sendMediaMessage(PHONE, 'https://x.com/img.jpg', 'caption');
      expect(result).toBe(true);
      expect(twilioService.sendWhatsAppMedia).toHaveBeenCalledWith(
        PHONE,
        'https://x.com/img.jpg',
        'caption',
      );
    });

    it('returns false when twilio returns null', async () => {
      (twilioService.sendWhatsAppMedia as jest.Mock).mockResolvedValue(null);

      const result = await service.sendMediaMessage(PHONE, 'https://x.com/img.jpg');
      expect(result).toBe(false);
    });
  });

  describe('saveMessage()', () => {
    it('creates message in DB', async () => {
      await service.saveMessage(PROFILE_ID, MessageDirection.INBOUND, 'Hi there');

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          profile_id: PROFILE_ID,
          direction: MessageDirection.INBOUND,
          platform: BotPlatform.WHATSAPP,
          body: 'Hi there',
        },
      });
    });

    it('includes sentById when provided', async () => {
      await service.saveMessage(PROFILE_ID, MessageDirection.OUTBOUND, 'Hello', 'admin-1');

      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ sent_by_id: 'admin-1' }),
      });
    });
  });

  describe('verifyWhatsAppToken()', () => {
    it('verifies token and marks profile as WhatsApp connected', async () => {
      redis.get.mockResolvedValue(PROFILE_ID);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        phone: PHONE,
        first_name: 'Alice',
      });

      await service.verifyWhatsAppToken('valid-token');

      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { whatsapp_connected: true },
      });
      expect(redis.del).toHaveBeenCalled();
    });

    it('throws BadRequestException for empty token', async () => {
      await expect(service.verifyWhatsAppToken('')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when token not found in redis', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.verifyWhatsAppToken('unknown-token')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when profile not found', async () => {
      redis.get.mockResolvedValue(PROFILE_ID);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.verifyWhatsAppToken('token')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('sends success message via WhatsApp when configured', async () => {
      redis.get.mockResolvedValue(PROFILE_ID);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        phone: PHONE,
        first_name: 'Alice',
      });
      (twilioService.isConfigured as jest.Mock).mockReturnValue(true);

      await service.verifyWhatsAppToken('valid-token');

      expect(twilioService.sendWhatsApp).toHaveBeenCalled();
    });

    it('does not send message when Twilio is not configured', async () => {
      redis.get.mockResolvedValue(PROFILE_ID);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        phone: PHONE,
        first_name: 'Alice',
      });
      (twilioService.isConfigured as jest.Mock).mockReturnValue(false);

      await service.verifyWhatsAppToken('valid-token');

      expect(twilioService.sendWhatsApp).not.toHaveBeenCalled();
    });
  });
});
