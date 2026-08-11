import { Logger, BadRequestException } from '@nestjs/common';
import { WhatsAppController } from '../whatsapp.controller';
import { InboundIngestService } from '../webhooks/inbound-ingest.service';

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
    handleIncomingMessage: jest
      .fn()
      .mockResolvedValue({ profileId: 'p-1', replies: ['Hello back!'] }),
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
  const pipelineObj = {
    incr: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([
      [null, 1],
      [null, 1],
    ]),
  };
  return {
    set: jest.fn().mockResolvedValue('OK'), // 'OK' = new key set
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn().mockReturnValue(pipelineObj),
  };
}

/**
 * A real SendTimingService is not needed, but a real InboundIngestService is:
 * de-duplication, rate limiting and the enqueue moved there, and wiring the
 * genuine collaborator keeps these assertions testing the path production
 * takes rather than a mock's shape.
 */
function makeSendTiming() {
  return {
    time: jest.fn(
      (
        _stage: string,
        _dir: string,
        _meta: unknown,
        fn: () => Promise<unknown>,
      ) => fn(),
    ),
    observe: jest.fn(),
    recordDelivered: jest.fn().mockResolvedValue(undefined),
    markSent: jest.fn().mockResolvedValue(undefined),
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
  let sendTiming: ReturnType<typeof makeSendTiming>;

  beforeEach(() => {
    whatsAppService = makeWhatsAppService();
    conversationService = makeConversationService();
    twilioService = makeTwilioService();
    configService = makeConfigService();
    redis = makeRedis();
    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };
    sendTiming = makeSendTiming();
    const ingest = new InboundIngestService(
      redis as any,
      queueService as any,
      sendTiming as any,
      // Twilio: no read receipts, no typing, no Flows.
      {
        name: 'twilio',
        capabilities: { readReceipts: false, typingIndicator: false },
        markAsRead: jest.fn(),
        sendTypingIndicator: jest.fn(),
      } as any,
      { handleSubmission: jest.fn().mockResolvedValue(undefined) } as any,
      // Claims are granted; the queued path does not claim here anyway.
      {
        claim: jest.fn().mockResolvedValue(true),
        release: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    controller = new WhatsAppController(
      whatsAppService as any,
      twilioService as any,
      configService as any,
      ingest,
      { name: 'twilio' } as any,
    );
    // Avoid unused-warning; conversationService isn't injected anymore.
    void conversationService;
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
    const body = {
      From: 'whatsapp:+24200000001',
      Body: 'Hello',
      MessageSid: 'SM123',
    };

    it('enqueues inbound webhook for background processing', async () => {
      await controller.incomingWebhook(makeReq(), body);
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          phone: '+24200000001',
          text: 'Hello',
          messageSid: 'SM123',
          provider: 'twilio',
        }),
        expect.objectContaining({ jobId: 'wa-in-SM123' }),
      );
    });

    it('throws ForbiddenException when auth token not set', async () => {
      twilioService.getAuthToken.mockReturnValue(null);
      await expect(controller.incomingWebhook(makeReq(), body)).rejects.toThrow(
        'configuré',
      );
    });

    it('throws ForbiddenException when signature header missing', async () => {
      const req = makeReq({ headers: {} });
      await expect(controller.incomingWebhook(req, body)).rejects.toThrow(
        'Signature',
      );
    });

    it('throws ForbiddenException when signature invalid', async () => {
      twilioService.validateWebhookSignature.mockReturnValue(false);
      await expect(controller.incomingWebhook(makeReq(), body)).rejects.toThrow(
        'Signature invalide',
      );
    });

    it('throws BadRequestException when From is missing', async () => {
      await expect(
        controller.incomingWebhook(makeReq(), {
          Body: 'test',
          MessageSid: 'SM001',
        }),
      ).rejects.toThrow("'From' manquant");
    });

    it('still enqueues a replay — dedup is the worker\'s job now', async () => {
      // Both providers share one contract: the webhook verifies, enqueues and
      // acknowledges; the worker decides whether the message has been handled.
      // Covered end to end in whatsapp-inbound.processor.spec.ts.
      await controller.incomingWebhook(makeReq(), body);
      await controller.incomingWebhook(makeReq(), body);
      expect(queueService.addJob).toHaveBeenCalledTimes(2);
      // Same jobId both times, so BullMQ collapses them before the worker runs.
      const ids = queueService.addJob.mock.calls.map((c) => c[2]?.jobId);
      expect(ids[0]).toBe(ids[1]);
    });

    it('strips whatsapp: prefix from From field', async () => {
      await controller.incomingWebhook(makeReq(), {
        ...body,
        From: 'whatsapp:+24200000001',
      });
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ phone: '+24200000001' }),
        expect.anything(),
      );
    });

    it('handles From without whatsapp: prefix', async () => {
      await controller.incomingWebhook(makeReq(), {
        ...body,
        From: '+24200000001',
      });
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ phone: '+24200000001' }),
        expect.anything(),
      );
    });

    it('routes quick-reply ButtonPayload as the message text', async () => {
      await controller.incomingWebhook(makeReq(), {
        From: 'whatsapp:+24200000001',
        ButtonPayload: '1',
        ButtonText: 'Postuler',
        Body: 'Postuler',
        MessageSid: 'SM999',
      });
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ phone: '+24200000001', text: '1' }),
        expect.anything(),
      );
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
      const result = await controller.verifyWhatsApp({
        token: 'valid-token',
      } as any);
      expect(result.success).toBe(true);
    });

    it('rethrows BadRequestException from service', async () => {
      whatsAppService.verifyWhatsAppToken.mockRejectedValue(
        new BadRequestException('Token expiré'),
      );
      await expect(
        controller.verifyWhatsApp({ token: 'bad' } as any),
      ).rejects.toThrow('Token expiré');
    });

    it('wraps other errors in BadRequestException', async () => {
      whatsAppService.verifyWhatsAppToken.mockRejectedValue(
        new Error('DB error'),
      );
      await expect(
        controller.verifyWhatsApp({ token: 'bad' } as any),
      ).rejects.toThrow('DB error');
    });
  });
});
