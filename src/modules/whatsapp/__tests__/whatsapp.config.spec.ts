import {
  WhatsappConfigError,
  parseWhatsappConfig,
  validateWhatsappEnv,
} from '../whatsapp.config';

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC0000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'secret-token',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
};

const CLOUD_ENV = {
  WHATSAPP_PROVIDER: 'cloud',
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_CLOUD_ACCESS_TOKEN: 'EAAG-token',
  WHATSAPP_CLOUD_APP_SECRET: 'app-secret',
  WHATSAPP_CLOUD_VERIFY_TOKEN: 'verify-token',
  WHATSAPP_CLOUD_WABA_ID: '987654321',
};

describe('parseWhatsappConfig', () => {
  it('defaults to twilio when WHATSAPP_PROVIDER is unset', () => {
    const config = parseWhatsappConfig({ ...TWILIO_ENV });
    expect(config.provider).toBe('twilio');
  });

  it('treats a blank WHATSAPP_PROVIDER as unset rather than invalid', () => {
    const config = parseWhatsappConfig({
      ...TWILIO_ENV,
      WHATSAPP_PROVIDER: '   ',
    });
    expect(config.provider).toBe('twilio');
  });

  it('rejects an unknown provider by name', () => {
    expect(() =>
      parseWhatsappConfig({ ...TWILIO_ENV, WHATSAPP_PROVIDER: 'vonage' }),
    ).toThrow(/must be "twilio" or "cloud", received "vonage"/);
  });

  describe('twilio', () => {
    it('resolves credentials', () => {
      const config = parseWhatsappConfig({ ...TWILIO_ENV });
      expect(config).toEqual({
        provider: 'twilio',
        accountSid: TWILIO_ENV.TWILIO_ACCOUNT_SID,
        authToken: TWILIO_ENV.TWILIO_AUTH_TOKEN,
        whatsappFrom: TWILIO_ENV.TWILIO_WHATSAPP_FROM,
        smsFrom: null,
      });
    });

    it('names a missing variable', () => {
      const { TWILIO_AUTH_TOKEN, ...rest } = TWILIO_ENV;
      expect(TWILIO_AUTH_TOKEN).toBeDefined();
      expect(() => parseWhatsappConfig(rest)).toThrow(/TWILIO_AUTH_TOKEN/);
    });

    it('rejects a variable that is present but empty', () => {
      expect(() =>
        parseWhatsappConfig({ ...TWILIO_ENV, TWILIO_AUTH_TOKEN: '' }),
      ).toThrow(/TWILIO_AUTH_TOKEN/);
    });

    it('does not require any Cloud variable', () => {
      expect(() => parseWhatsappConfig({ ...TWILIO_ENV })).not.toThrow();
    });

    it('keeps an optional SMS sender when provided', () => {
      const config = parseWhatsappConfig({
        ...TWILIO_ENV,
        TWILIO_SMS_FROM: '+14155238886',
      });
      expect(config).toMatchObject({ smsFrom: '+14155238886' });
    });
  });

  describe('cloud', () => {
    it('resolves credentials and defaults the API version', () => {
      const config = parseWhatsappConfig({ ...CLOUD_ENV });
      expect(config).toEqual({
        provider: 'cloud',
        apiVersion: 'v25.0',
        phoneNumberId: '123456789',
        accessToken: 'EAAG-token',
        appSecret: 'app-secret',
        verifyToken: 'verify-token',
        wabaId: '987654321',
      });
    });

    it('honours an explicit API version', () => {
      const config = parseWhatsappConfig({
        ...CLOUD_ENV,
        WHATSAPP_CLOUD_API_VERSION: 'v26.1',
      });
      expect(config).toMatchObject({ apiVersion: 'v26.1' });
    });

    it('rejects a malformed API version', () => {
      expect(() =>
        parseWhatsappConfig({
          ...CLOUD_ENV,
          WHATSAPP_CLOUD_API_VERSION: '25.0',
        }),
      ).toThrow(/WHATSAPP_CLOUD_API_VERSION/);
    });

    it('fails fast naming a missing Cloud variable', () => {
      const { WHATSAPP_CLOUD_ACCESS_TOKEN, ...rest } = CLOUD_ENV;
      expect(WHATSAPP_CLOUD_ACCESS_TOKEN).toBeDefined();
      expect(() => parseWhatsappConfig(rest)).toThrow(
        /WHATSAPP_CLOUD_ACCESS_TOKEN/,
      );
    });

    it('reports every missing variable at once, not just the first', () => {
      let message = '';
      try {
        parseWhatsappConfig({ WHATSAPP_PROVIDER: 'cloud' });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
      expect(message).toContain('WHATSAPP_CLOUD_ACCESS_TOKEN');
      expect(message).toContain('WHATSAPP_CLOUD_APP_SECRET');
      expect(message).toContain('WHATSAPP_CLOUD_VERIFY_TOKEN');
      expect(message).toContain('WHATSAPP_CLOUD_WABA_ID');
    });

    it('does not require any Twilio variable', () => {
      expect(() => parseWhatsappConfig({ ...CLOUD_ENV })).not.toThrow();
    });

    it('throws WhatsappConfigError, not a raw ZodError', () => {
      expect(() => parseWhatsappConfig({ WHATSAPP_PROVIDER: 'cloud' })).toThrow(
        WhatsappConfigError,
      );
    });

    it('never echoes a secret value into the error message', () => {
      let message = '';
      try {
        parseWhatsappConfig({
          ...CLOUD_ENV,
          WHATSAPP_CLOUD_API_VERSION: 'nope',
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).not.toContain('EAAG-token');
      expect(message).not.toContain('app-secret');
    });
  });
});

describe('validateWhatsappEnv', () => {
  it('passes the whole environment through untouched', () => {
    const env = { ...TWILIO_ENV, DATABASE_URL: 'postgres://x', PORT: '3000' };
    expect(validateWhatsappEnv(env)).toBe(env);
  });

  it('throws when the active provider is misconfigured', () => {
    expect(() =>
      validateWhatsappEnv({ WHATSAPP_PROVIDER: 'cloud', PORT: '3000' }),
    ).toThrow(WhatsappConfigError);
  });
});
