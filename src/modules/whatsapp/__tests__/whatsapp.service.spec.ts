import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { WhatsAppService } from '../whatsapp.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  WHATSAPP_PROVIDER,
  WhatsappError,
  type WhatsappProvider,
} from '../contracts';

/** What the provider throws when it has no client at all. */
const notConfigured = () =>
  new WhatsappError({
    code: 'NOT_CONFIGURED',
    provider: 'twilio',
    message: 'Twilio is not configured',
  });
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { ConfigService } from '@nestjs/config';
import { WalletService } from '../../wallet/wallet.service';
import { IdempotencyService } from '../../../common/services/idempotency/idempotency.service';

// Prevent the real Twilio SDK from being loaded in this test suite
jest.mock('twilio', () => {
  const factory = jest
    .fn()
    .mockReturnValue({ messages: { create: jest.fn() } });
  (factory as unknown as Record<string, unknown>).validateRequest = jest
    .fn()
    .mockReturnValue(true);
  return factory;
});

const PROFILE_ID = 'profile-uuid-1';
const PHONE = '+24200000001';

describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let prisma: jest.Mocked<PrismaService>;
  let provider: jest.Mocked<WhatsappProvider>;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let module: TestingModule;

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const mockPrismaService = {
      message: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      profile: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const ok = (id: string) => ({ providerMessageId: id, provider: 'twilio' });
    const mockProvider = {
      name: 'twilio',
      capabilities: { typingIndicator: false, readReceipts: false },
      sendText: jest.fn().mockResolvedValue(ok('SM-sid')),
      sendMedia: jest.fn().mockResolvedValue(ok('SM-media-sid')),
      sendTemplate: jest.fn().mockResolvedValue(ok('SM-template-sid')),
      sendTemplateWithVariables: jest
        .fn()
        .mockResolvedValue(ok('SM-template-sid')),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    module = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WHATSAPP_PROVIDER, useValue: mockProvider },
        { provide: REDIS_CONNECTION, useValue: redis },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test') },
        },
        {
          provide: WalletService,
          useValue: {
            getProfileWalletBalance: jest.fn().mockResolvedValue(0),
            grantWelcomeCredit: jest.fn().mockResolvedValue(0),
            getOrCreateProfileWallet: jest
              .fn()
              .mockResolvedValue({ balance: 0 }),
          },
        },
        {
          // Claims granted by default, so these tests keep exercising the send
          // path rather than the duplicate guard. The guard has its own tests.
          provide: IdempotencyService,
          useValue: {
            claim: jest.fn().mockResolvedValue(true),
            release: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<WhatsAppService>(WhatsAppService);
    prisma = module.get(PrismaService);
    provider = module.get(WHATSAPP_PROVIDER);
  });

  describe('isConfigured()', () => {
    it('delegates to the provider', () => {
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('sendTextMessage()', () => {
    it('sends text and returns true when SID is returned', async () => {
      const result = await service.sendTextMessage(PHONE, 'Hello');
      expect(result).toBe(true);
      expect(provider.sendText).toHaveBeenCalledWith(PHONE, 'Hello');
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

    it('returns false when the provider is not configured', async () => {
      (provider.sendText as jest.Mock).mockRejectedValue(notConfigured());

      const result = await service.sendTextMessage(PHONE, 'Hello');
      expect(result).toBe(false);
    });
  });

  describe('sendMediaMessage()', () => {
    it('sends media message and returns true', async () => {
      const result = await service.sendMediaMessage(
        PHONE,
        'https://x.com/img.jpg',
        'caption',
      );
      expect(result).toBe(true);
      expect(provider.sendMedia).toHaveBeenCalledWith(PHONE, {
        kind: 'image',
        url: 'https://x.com/img.jpg',
        caption: 'caption',
      });
    });

    it('returns false when the provider is not configured', async () => {
      (provider.sendMedia as jest.Mock).mockRejectedValue(notConfigured());

      const result = await service.sendMediaMessage(
        PHONE,
        'https://x.com/img.jpg',
      );
      expect(result).toBe(false);
    });
  });

  // TwilioService rethrows the SDK error; every send here must absorb it into a
  // false so the ~40 bare-awaiting call sites can't turn a Twilio outage into an
  // unhandled 500.
  describe('twilio failures never escape', () => {
    it.each([
      [
        'sendTextMessage',
        'sendText' as const,
        () => service.sendTextMessage(PHONE, 'Hello'),
      ],
      [
        'sendTemplateMessage',
        'sendTemplate' as const,
        () => service.sendTemplateMessage(PHONE, 'otp', '000000'),
      ],
      [
        'sendMediaMessage',
        'sendMedia' as const,
        () => service.sendMediaMessage(PHONE, 'https://x.com/img.jpg'),
      ],
    ])('%s returns false when twilio throws', async (_name, method, call) => {
      (provider[method] as jest.Mock).mockRejectedValue(
        new Error('[Twilio 20003] Authentication Error - invalid username'),
      );

      await expect(call()).resolves.toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });
  });

  describe('saveMessage()', () => {
    it('creates message in DB', async () => {
      await service.saveMessage(
        PROFILE_ID,
        MessageDirection.INBOUND,
        'Hi there',
      );

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
      await service.saveMessage(
        PROFILE_ID,
        MessageDirection.OUTBOUND,
        'Hello',
        'admin-1',
      );

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

      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: PROFILE_ID },
          data: expect.objectContaining({ whatsapp_connected: true }),
        }),
      );
      expect(redis.del).toHaveBeenCalled();
    });

    it('throws BadRequestException for empty token', async () => {
      await expect(service.verifyWhatsAppToken('')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when token not found in redis', async () => {
      redis.get.mockResolvedValue(null);

      await expect(
        service.verifyWhatsAppToken('unknown-token'),
      ).rejects.toThrow(BadRequestException);
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
      (provider.isConfigured as jest.Mock).mockReturnValue(true);

      await service.verifyWhatsAppToken('valid-token');

      expect(provider.sendText).toHaveBeenCalled();
    });

    it('does not send message when Twilio is not configured', async () => {
      redis.get.mockResolvedValue(PROFILE_ID);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        phone: PHONE,
        first_name: 'Alice',
      });
      (provider.isConfigured as jest.Mock).mockReturnValue(false);

      await service.verifyWhatsAppToken('valid-token');

      expect(provider.sendText).not.toHaveBeenCalled();
    });
  });

  describe('isServiceWindowOpen', () => {
    const inboundAt = (msAgo: number) => ({
      created_at: new Date(Date.now() - msAgo),
    });
    const HOUR = 60 * 60 * 1000;

    it('is closed when the profile has never messaged us', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);

      // The dominant real case: profiles sign up on the web and never message
      // the bot, so free-form would be rejected on the very first admin message.
      await expect(service.isServiceWindowOpen(PROFILE_ID)).resolves.toEqual({
        open: false,
        lastInboundAt: null,
      });
    });

    it('is open just inside the window', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(
        inboundAt(23 * HOUR),
      );

      const result = await service.isServiceWindowOpen(PROFILE_ID);

      expect(result.open).toBe(true);
      expect(result.lastInboundAt).toBeInstanceOf(Date);
    });

    it('is closed inside the safety margin, before the 24h mark', async () => {
      // 23h58m — technically still inside WhatsApp's window, but close enough
      // that clock skew and dispatch latency could push the send past it.
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(
        inboundAt(23 * HOUR + 58 * 60 * 1000),
      );

      const result = await service.isServiceWindowOpen(PROFILE_ID);

      expect(result.open).toBe(false);
    });

    it('is closed well past the window', async () => {
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(
        inboundAt(25 * HOUR),
      );

      const result = await service.isServiceWindowOpen(PROFILE_ID);

      expect(result.open).toBe(false);
    });

    it('only counts INBOUND WhatsApp messages', async () => {
      await service.isServiceWindowOpen(PROFILE_ID);

      // An admin email is written into this same table; reading one as evidence
      // of an open WhatsApp session would be exactly wrong.
      expect(prisma.message.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            profile_id: PROFILE_ID,
            direction: MessageDirection.INBOUND,
            platform: BotPlatform.WHATSAPP,
          },
          orderBy: { created_at: 'desc' },
          select: { created_at: true },
        }),
      );
    });
  });

  describe('sendAdminMessage', () => {
    const HOUR = 60 * 60 * 1000;
    const openWindow = () =>
      (prisma.message.findFirst as jest.Mock).mockResolvedValue({
        created_at: new Date(Date.now() - HOUR),
      });
    const closedWindow = () =>
      (prisma.message.findFirst as jest.Mock).mockResolvedValue(null);

    const base = {
      phone: PHONE,
      profileId: PROFILE_ID,
      adminName: 'Fariol Blondeau',
      adminUserId: 'admin-uuid-1',
    };

    it('sends free-form and keeps line breaks while the window is open', async () => {
      openWindow();

      const result = await service.sendAdminMessage({
        ...base,
        message: 'Bonjour,\n\nVotre compte est actif.',
      });

      expect(result).toEqual({ mode: 'FREE_FORM', sent: true });
      expect(provider.sendTemplate).not.toHaveBeenCalled();

      const [, body] = (provider.sendText as jest.Mock).mock.calls[0];
      expect(body).toContain('Bonjour,\n\nVotre compte est actif.');
      expect(body).toContain('_Fariol Blondeau — L’équipe Rabotka_');
    });

    it('sends the approved template, flattened, once the window has closed', async () => {
      closedWindow();

      const result = await service.sendAdminMessage({
        ...base,
        message: 'Bonjour,\n\nVotre compte est actif.',
      });

      expect(result).toEqual({ mode: 'TEMPLATE', sent: true });
      expect(provider.sendText).not.toHaveBeenCalled();

      const [, key, params] = (provider.sendTemplate as jest.Mock).mock
        .calls[0];
      expect(key).toBe('adminMessage');
      // Meta rejects newlines inside a variable, so the flattening has to
      // happen before the params leave this service.
      expect(params.message).toBe('Bonjour, · Votre compte est actif.');
      expect(params.adminName).toBe('Fariol Blondeau');
    });

    it('persists the delivered body with the sending admin, exactly once', async () => {
      closedWindow();

      await service.sendAdminMessage({ ...base, message: 'Compte actif.' });

      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          profile_id: PROFILE_ID,
          direction: MessageDirection.OUTBOUND,
          platform: BotPlatform.WHATSAPP,
          sent_by_id: 'admin-uuid-1',
          // What the profile actually received, not a "[TPL:…]" marker.
          body: expect.stringContaining('Compte actif.'),
        }),
      });
    });

    it('reports a Twilio failure instead of swallowing it, and persists nothing', async () => {
      closedWindow();
      (provider.sendTemplate as jest.Mock).mockRejectedValue(
        new Error('[Twilio 63016] outside the 24h window — message failed'),
      );

      const result = await service.sendAdminMessage({
        ...base,
        message: 'Compte actif.',
      });

      expect(result.sent).toBe(false);
      expect(result.mode).toBe('TEMPLATE');
      expect(result.error).toContain('63016');
      // A bubble in the thread for a message that never arrived would be the
      // same lie as the endpoint returning success.
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('reports failure when Twilio is unconfigured and returns no sid', async () => {
      openWindow();
      (provider.sendText as jest.Mock).mockRejectedValue(notConfigured());

      const result = await service.sendAdminMessage({
        ...base,
        message: 'Compte actif.',
      });

      expect(result.sent).toBe(false);
      expect(prisma.message.create).not.toHaveBeenCalled();
    });

    it('rejects an over-length template message before calling Twilio', async () => {
      closedWindow();

      await expect(
        service.sendAdminMessage({ ...base, message: 'x'.repeat(701) }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(provider.sendTemplate).not.toHaveBeenCalled();
    });

    it('does not apply the template limit while the window is open', async () => {
      openWindow();

      const result = await service.sendAdminMessage({
        ...base,
        message: 'x'.repeat(701),
      });

      expect(result).toEqual({ mode: 'FREE_FORM', sent: true });
    });

    it('rejects a message that is only whitespace', async () => {
      closedWindow();

      await expect(
        service.sendAdminMessage({ ...base, message: '  \n\n \t ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('falls back to a signature rather than sending an empty variable', async () => {
      closedWindow();

      await service.sendAdminMessage({
        ...base,
        adminName: '   ',
        message: 'Compte actif.',
      });

      const [, , params] = (provider.sendTemplate as jest.Mock).mock.calls[0];
      // Meta rejects an empty variable value outright.
      expect(params.adminName).toBe('Le support');
    });
  });

  describe('outbound duplicate guard', () => {
    // The provider-agnostic safety net: whatever the upstream cause, this is
    // the last thing between a duplicate and the reader.
    function guard() {
      return module.get(IdempotencyService) as unknown as {
        claim: jest.Mock;
      };
    }

    it('sends when the claim is granted', async () => {
      guard().claim.mockResolvedValue(true);
      await expect(
        service.sendTemplateMessage(PHONE, 'otp', '000000'),
      ).resolves.toBe(true);
      expect(provider.sendTemplate).toHaveBeenCalled();
    });

    it('blocks the send when the claim is refused', async () => {
      guard().claim.mockResolvedValue(false);
      await expect(
        service.sendTemplateMessage(PHONE, 'otp', '000000'),
      ).resolves.toBe(false);
      expect(provider.sendTemplate).not.toHaveBeenCalled();
    });

    it('does not throw on a blocked send', async () => {
      // A duplicate is not an error. Throwing would fail a BullMQ job that has
      // nothing left to do, and burn its retries.
      guard().claim.mockResolvedValue(false);
      await expect(
        service.sendTemplateMessage(PHONE, 'otp', '000000'),
      ).resolves.toBe(false);
    });

    it('keys on recipient, template and params together', async () => {
      guard().claim.mockResolvedValue(true);
      await service.sendTemplateMessage(PHONE, 'otp', '000000');

      const [key, ttl] = guard().claim.mock.calls[0] as [string, number];
      expect(key).toContain('wa:out:');
      expect(key).toContain(PHONE);
      expect(key).toContain('otp');
      expect(ttl).toBe(60);
    });

    it('gives a different key to different params, so a resend is not eaten', async () => {
      // An OTP resend the reader asked for is not a duplicate. Keying on the
      // template alone would silently swallow the second code.
      guard().claim.mockResolvedValue(true);
      await service.sendTemplateMessage(PHONE, 'otp', '111111');
      await service.sendTemplateMessage(PHONE, 'otp', '222222');

      const keys = guard().claim.mock.calls.map((c) => c[0] as string);
      expect(keys[0]).not.toBe(keys[1]);
      expect(provider.sendTemplate).toHaveBeenCalledTimes(2);
    });

    it('gives the same key to an identical repeat', async () => {
      guard().claim.mockResolvedValue(true);
      await service.sendTemplateMessage(PHONE, 'otp', '000000');
      await service.sendTemplateMessage(PHONE, 'otp', '000000');

      const keys = guard().claim.mock.calls.map((c) => c[0] as string);
      expect(keys[0]).toBe(keys[1]);
    });

    it('sends anyway when Redis is unreachable', async () => {
      // Fails OPEN. A duplicate is an annoyance; silence is a broken product.
      guard().claim.mockRejectedValue(new Error('redis down'));
      await expect(
        service.sendTemplateMessage(PHONE, 'otp', '000000'),
      ).resolves.toBe(true);
      expect(provider.sendTemplate).toHaveBeenCalled();
    });

    it('guards the legacy variables path too', async () => {
      guard().claim.mockResolvedValue(false);
      await expect(
        service.sendTemplateMessageWithVariables(PHONE, 'otp', { '1': 'x' }),
      ).resolves.toBe(false);
      expect(provider.sendTemplateWithVariables).not.toHaveBeenCalled();
    });
  });
});
