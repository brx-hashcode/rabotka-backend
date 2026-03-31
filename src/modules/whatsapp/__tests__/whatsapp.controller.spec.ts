import { Logger, BadRequestException } from '@nestjs/common';
import { WhatsAppController } from '../whatsapp.controller';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

function makeWhatsAppService() {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    sendTextMessage: jest.fn().mockResolvedValue(true),
    sendMediaMessage: jest.fn().mockResolvedValue(true),
    verifyWhatsAppToken: jest.fn().mockResolvedValue({ profileId: 'p-1' }),
  };
}

function makeConversationService() {
  return {
    handleIncomingMessage: jest.fn().mockResolvedValue({ profileId: 'p-1', replies: ['Hello back!'] }),
  };
}

function makeTwilioService() {
  return {
    getAuthToken: jest.fn().mockReturnValue('test-token'),
    validateWebhookSignature: jest.fn().mockReturnValue(true),
  };
}

function makeConfigService() {
  return {
    get: jest.fn().mockReturnValue(undefined),
  };
}

function makeRedis() {
  return {
    set: jest.fn().mockResolvedValue('OK'), // 'OK' = new key set
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: { 'x-twilio-signature': 'valid-sig' },
    protocol: 'https',
    get: jest.fn().mockReturnValue('example.com'),
    originalUrl: '/whatsapp/incoming',
    ...overrides,
  } as any;
}

describe('WhatsAppController', () => {
  let controller: WhatsAppController;
  let whatsAppService: ReturnType<typeof makeWhatsAppService>;
  let conversationService: ReturnType<typeof makeConversationService>;
  let twilioService: ReturnType<typeof makeTwilioService>;
  let configService: ReturnType<typeof makeConfigService>;
  let redis: ReturnType<typeof makeRedis>;
  let queueService: { addJob: jest.Mock };

  beforeEach(() => {
    whatsAppService = makeWhatsAppService();
    conversationService = makeConversationService();
    twilioService = makeTwilioService();
    configService = makeConfigService();
    redis = makeRedis();
    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };
    controller = new WhatsAppController(
      whatsAppService as any,
      conversationService as any,
      twilioService as any,
      configService as any,
      queueService as any,
      redis as any,
    );
  });

  describe('getStatus()', () => {
    it('returns configured: true when service is configured', () => {
      const result = controller.getStatus();
      expect(result).toEqual({ configured: true });
    });

    it('returns configured: false when service is not configured', () => {
      whatsAppService.isConfigured.mockReturnValue(false);
      const result = controller.getStatus();
      expect(result).toEqual({ configured: false });
    });
  });

  describe('incomingWebhook()', () => {
    const body = { From: 'whatsapp:+24200000001', Body: 'Hello', MessageSid: 'SM123' };

    it('processes webhook and sends reply', async () => {
      await controller.incomingWebhook(makeReq(), body);
      expect(conversationService.handleIncomingMessage).toHaveBeenCalledWith('+24200000001', 'Hello');
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'text', phone: '+24200000001', text: 'Hello back!' }),
      );
    });

    it('throws ForbiddenException when auth token not set', async () => {
      twilioService.getAuthToken.mockReturnValue(null);
      await expect(controller.incomingWebhook(makeReq(), body)).rejects.toThrow('configuré');
    });

    it('throws ForbiddenException when signature header missing', async () => {
      const req = makeReq({ headers: {} });
      await expect(controller.incomingWebhook(req, body)).rejects.toThrow('Signature');
    });

    it('throws ForbiddenException when signature invalid', async () => {
      twilioService.validateWebhookSignature.mockReturnValue(false);
      await expect(controller.incomingWebhook(makeReq(), body)).rejects.toThrow('Signature invalide');
    });

    it('throws BadRequestException when From is missing', async () => {
      await expect(
        controller.incomingWebhook(makeReq(), { Body: 'test', MessageSid: 'SM001' }),
      ).rejects.toThrow("'From' manquant");
    });

    it('skips duplicate message (NX returns null)', async () => {
      redis.set.mockResolvedValue(null); // already processed
      await controller.incomingWebhook(makeReq(), body);
      expect(conversationService.handleIncomingMessage).not.toHaveBeenCalled();
    });

    it('handles media reply messages with [IMG:...] prefix', async () => {
      conversationService.handleIncomingMessage.mockResolvedValue({
        profileId: 'p-1',
        replies: ['[IMG:https://cdn.example.com/photo.jpg]Caption text'],
      });
      await controller.incomingWebhook(makeReq(), body);
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'media', phone: '+24200000001', mediaUrl: 'https://cdn.example.com/photo.jpg', caption: 'Caption text' }),
      );
    });

    it('strips whatsapp: prefix from From field', async () => {
      await controller.incomingWebhook(makeReq(), { ...body, From: 'whatsapp:+24200000001' });
      expect(conversationService.handleIncomingMessage).toHaveBeenCalledWith('+24200000001', 'Hello');
    });

    it('handles From without whatsapp: prefix', async () => {
      await controller.incomingWebhook(makeReq(), { ...body, From: '+24200000001' });
      expect(conversationService.handleIncomingMessage).toHaveBeenCalledWith('+24200000001', 'Hello');
    });

    it('uses TWILIO_WEBHOOK_BASE_URL from config when set', async () => {
      configService.get.mockReturnValue('https://my-ngrok.io');
      await controller.incomingWebhook(makeReq(), body);
      expect(twilioService.validateWebhookSignature).toHaveBeenCalledWith(
        'valid-sig',
        'https://my-ngrok.io/whatsapp/incoming',
        body,
      );
    });
  });

  describe('verifyWhatsApp()', () => {
    it('returns success when token is valid', async () => {
      const result = await controller.verifyWhatsApp({ token: 'valid-token' } as any);
      expect(result.success).toBe(true);
    });

    it('rethrows BadRequestException from service', async () => {
      whatsAppService.verifyWhatsAppToken.mockRejectedValue(
        new BadRequestException('Token expiré'),
      );
      await expect(controller.verifyWhatsApp({ token: 'bad' } as any)).rejects.toThrow('Token expiré');
    });

    it('wraps other errors in BadRequestException', async () => {
      whatsAppService.verifyWhatsAppToken.mockRejectedValue(new Error('DB error'));
      await expect(controller.verifyWhatsApp({ token: 'bad' } as any)).rejects.toThrow('DB error');
    });
  });
});
