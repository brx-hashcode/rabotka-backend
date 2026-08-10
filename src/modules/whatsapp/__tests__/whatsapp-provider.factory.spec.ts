import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assertTemplateBindings,
  createWhatsappProvider,
} from '../whatsapp-provider.factory';
import { TwilioProvider } from '../providers/twilio/twilio.provider';
import type { TwilioService } from '../../../common/services/twilio/twilio.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC0000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};

function twilioProvider(): TwilioProvider {
  return new TwilioProvider({
    isConfigured: () => true,
  } as unknown as TwilioService);
}

const config = {
  get: () => 'whatsapp:+14155238886',
} as unknown as ConfigService;

describe('assertTemplateBindings', () => {
  const logger = new Logger('test');

  it('passes for the real registry on both providers', () => {
    expect(() => assertTemplateBindings('twilio', logger)).not.toThrow();
    expect(() => assertTemplateBindings('cloud', logger)).not.toThrow();
  });
});

describe('createWhatsappProvider', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  function withEnv(env: Record<string, string | undefined>) {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('WHATSAPP_') || key.startsWith('TWILIO_')) {
        delete process.env[key];
      }
    }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it('resolves Twilio by default', () => {
    withEnv(TWILIO_ENV);
    expect(createWhatsappProvider(config, twilioProvider()).name).toBe(
      'twilio',
    );
  });

  it('resolves Twilio when asked for explicitly', () => {
    withEnv({ ...TWILIO_ENV, WHATSAPP_PROVIDER: 'twilio' });
    expect(createWhatsappProvider(config, twilioProvider()).name).toBe(
      'twilio',
    );
  });

  it('refuses to boot on a misconfigured provider rather than sending nothing', () => {
    withEnv({ WHATSAPP_PROVIDER: 'twilio' });
    expect(() => createWhatsappProvider(config, twilioProvider())).toThrow(
      /TWILIO_ACCOUNT_SID/,
    );
  });

  it('resolves Cloud when asked for, and never silently falls back to Twilio', () => {
    // The worst outcome of a half-finished rollout would be a deploy that asked
    // for cloud, quietly kept sending through Twilio, and looked healthy.
    withEnv({
      WHATSAPP_PROVIDER: 'cloud',
      WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1',
      WHATSAPP_CLOUD_ACCESS_TOKEN: 't',
      WHATSAPP_CLOUD_APP_SECRET: 's',
      WHATSAPP_CLOUD_VERIFY_TOKEN: 'v',
      WHATSAPP_CLOUD_WABA_ID: 'w',
    });
    expect(createWhatsappProvider(config, twilioProvider()).name).toBe('cloud');
  });

  it('refuses to boot on cloud with a missing Cloud credential', () => {
    withEnv({
      WHATSAPP_PROVIDER: 'cloud',
      WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1',
    });
    expect(() => createWhatsappProvider(config, twilioProvider())).toThrow(
      /WHATSAPP_CLOUD_ACCESS_TOKEN/,
    );
  });
});
