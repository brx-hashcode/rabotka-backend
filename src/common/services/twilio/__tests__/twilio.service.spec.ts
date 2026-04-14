import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwilioService } from '../twilio.service';

// Silence NestJS logger output during tests
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

// The mock factory must not reference out-of-scope variables due to jest hoisting.
// We use a module-level variable via globalThis to share the mock.
const mockCreate = jest.fn();
const mockValidateRequest = jest.fn().mockReturnValue(true);

jest.mock('twilio', () => {
  const create = jest.fn();
  // Store reference on globalThis so we can control it per test
  (globalThis as Record<string, unknown>).__twilioCreate = create;
  const mockClient = { messages: { create } };
  const factory = jest.fn().mockReturnValue(mockClient);
  (factory as unknown as Record<string, unknown>).validateRequest = jest.fn().mockReturnValue(true);
  (globalThis as Record<string, unknown>).__twilioValidateRequest = (factory as unknown as Record<string, unknown>).validateRequest;
  return factory;
});

function getCreate(): jest.Mock {
  return (globalThis as Record<string, unknown>).__twilioCreate as jest.Mock;
}
function getValidateRequest(): jest.Mock {
  return (globalThis as Record<string, unknown>).__twilioValidateRequest as jest.Mock;
}

describe('TwilioService', () => {
  let service: TwilioService;
  let configService: jest.Mocked<ConfigService>;

  function buildService(env: Record<string, string | undefined>) {
    configService = {
      get: jest.fn().mockImplementation((key: string) => env[key]),
    } as unknown as jest.Mocked<ConfigService>;
    service = new TwilioService(configService);
  }

  beforeEach(() => {
    getCreate().mockReset();
    buildService({
      TWILIO_ACCOUNT_SID: 'AC-test-sid',
      TWILIO_AUTH_TOKEN: 'test-token',
      TWILIO_WHATSAPP_FROM: '+15550000000',
      TWILIO_SMS_FROM: '+15550000001',
    });
  });

  describe('isConfigured()', () => {
    it('returns true when all credentials are set', () => {
      expect(service.isConfigured()).toBe(true);
    });

    it('returns false when credentials are missing', () => {
      buildService({});
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('sendWhatsApp()', () => {
    it('sends a WhatsApp message and returns the SID', async () => {
      getCreate().mockResolvedValue({ sid: 'SM-test-sid' });

      const result = await service.sendWhatsApp('+24200000001', 'Hello');

      expect(result).toBe('SM-test-sid');
      expect(getCreate()).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'whatsapp:+24200000001',
          body: 'Hello',
        }),
      );
    });

    it('throws when Twilio throws an error', async () => {
      getCreate().mockRejectedValue(new Error('Twilio error'));

      await expect(service.sendWhatsApp('+24200000001', 'Hello')).rejects.toThrow();
    });

    it('returns null when not configured', async () => {
      buildService({});

      const result = await service.sendWhatsApp('+24200000001', 'Hello');

      expect(result).toBeNull();
    });

    it('formats phone numbers without + prefix correctly', async () => {
      getCreate().mockResolvedValue({ sid: 'SM-sid' });

      await service.sendWhatsApp('24200000001', 'test');

      expect(getCreate()).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'whatsapp:+24200000001' }),
      );
    });

    it('does not double-prefix whatsapp: numbers', async () => {
      getCreate().mockResolvedValue({ sid: 'SM-sid' });

      await service.sendWhatsApp('whatsapp:+24200000001', 'test');

      expect(getCreate()).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'whatsapp:+24200000001' }),
      );
    });
  });

  describe('sendWhatsAppMedia()', () => {
    it('sends media message and returns SID', async () => {
      getCreate().mockResolvedValue({ sid: 'SM-media-sid' });

      const result = await service.sendWhatsAppMedia(
        '+24200000001',
        'https://example.com/img.jpg',
        'Check this',
      );

      expect(result).toBe('SM-media-sid');
      expect(getCreate()).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaUrl: ['https://example.com/img.jpg'],
          body: 'Check this',
        }),
      );
    });

    it('returns null when not configured', async () => {
      buildService({});

      const result = await service.sendWhatsAppMedia('+242', 'https://x.com/img.jpg');

      expect(result).toBeNull();
    });
  });

  describe('sendSms()', () => {
    it('sends SMS and returns SID', async () => {
      getCreate().mockResolvedValue({ sid: 'SM-sms-sid' });

      const result = await service.sendSms('+24200000001', 'Hello SMS');

      expect(result).toBe('SM-sms-sid');
    });

    it('returns null when not configured', async () => {
      buildService({});

      const result = await service.sendSms('+24200000001', 'test');

      expect(result).toBeNull();
    });

    it('returns null when Twilio throws', async () => {
      getCreate().mockRejectedValue(new Error('fail'));

      const result = await service.sendSms('+24200000001', 'test');

      expect(result).toBeNull();
    });
  });

  describe('validateWebhookSignature()', () => {
    it('calls TwilioSDK.validateRequest and returns result', () => {
      getValidateRequest().mockReturnValue(true);

      const result = service.validateWebhookSignature(
        'sig',
        'https://example.com/webhook',
        { Body: 'hello' },
      );

      expect(result).toBe(true);
    });

    it('returns false when not configured (no auth token)', () => {
      buildService({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined });

      const result = service.validateWebhookSignature('sig', 'url', {});
      expect(result).toBe(false);
    });
  });
});
