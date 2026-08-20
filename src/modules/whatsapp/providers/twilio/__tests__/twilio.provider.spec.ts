import { Logger } from '@nestjs/common';
import { TwilioProvider } from '../twilio.provider';
import { TwilioSendError, twilioErrorCode } from '../twilio.errors';
import type { TwilioService } from '../../../../../common/services/twilio/twilio.service';
import {
  WhatsappCapabilityError,
  WhatsappError,
  type WhatsappErrorCode,
} from '../../../contracts';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

function makeProvider(overrides: Partial<TwilioService> = {}) {
  const twilio = {
    isConfigured: jest.fn().mockReturnValue(true),
    getAuthToken: jest.fn().mockReturnValue('token'),
    sendWhatsApp: jest.fn().mockResolvedValue('SM1'),
    sendWhatsAppTemplate: jest.fn().mockResolvedValue('SM2'),
    sendWhatsAppMedia: jest.fn().mockResolvedValue('SM3'),
    ...overrides,
  } as unknown as TwilioService;
  return { provider: new TwilioProvider(twilio), twilio };
}

describe('TwilioProvider', () => {
  it('reports its name and that it cannot do read receipts or typing', () => {
    const { provider } = makeProvider();
    expect(provider.name).toBe('twilio');
    expect(provider.capabilities.readReceipts).toBe(false);
    expect(provider.capabilities.typingIndicator).toBe(false);
    expect(provider.capabilities.freeformOutsideWindow).toBe(false);
  });

  describe('sends', () => {
    it('returns a normalized SendResult for text', async () => {
      const { provider } = makeProvider();
      await expect(provider.sendText('+242069917686', 'Hi')).resolves.toEqual({
        providerMessageId: 'SM1',
        provider: 'twilio',
      });
    });

    it('resolves a template key to its SID and numbered variables', async () => {
      const { provider, twilio } = makeProvider();
      await provider.sendTemplate('+242069917686', 'otp', '123456');
      expect(twilio.sendWhatsAppTemplate).toHaveBeenCalledWith(
        '+242069917686',
        expect.stringMatching(/^HX/),
        { '1': '123456' },
      );
    });

    it('passes pre-resolved variables straight through for legacy jobs', async () => {
      const { provider, twilio } = makeProvider();
      await provider.sendTemplateWithVariables('+242069917686', 'otp', {
        '1': '999999',
      });
      expect(twilio.sendWhatsAppTemplate).toHaveBeenCalledWith(
        '+242069917686',
        expect.stringMatching(/^HX/),
        { '1': '999999' },
      );
    });

    /**
     * Twilio is a BSP in front of the same Meta endpoint, so it forwards a
     * newline inside a ContentVariables value and has the send rejected with
     * 132018 exactly as the Cloud provider would. The guard sits on this method
     * rather than in `toContentVariables` because BOTH template paths converge
     * here — typed params above, and the outbound processor's own numbered map.
     */
    it('sanitizes variables Meta would reject', async () => {
      const { provider, twilio } = makeProvider();
      // `cancellation` rather than one of the reason-carrying KYC templates:
      // those are `cloudOnly`, so `toContentSid` throws before the guard runs.
      await provider.sendTemplateWithVariables(
        '+242069917686',
        'cancellation',
        {
          '1': 'Marie',
          '2': 'Serveuse',
          '3': '12/03',
          '4': 'Motif un.\r\nMotif deux.\r\n\r\nEquipe Rabotka.',
          '5': 'Aucune pénalité',
          '6': 'offer-1',
        },
      );

      const [, , variables] = jest.mocked(twilio.sendWhatsAppTemplate).mock
        .calls[0];
      for (const value of Object.values(variables ?? {})) {
        expect(value).not.toMatch(/[\n\t]|\s{4,}/);
      }
      expect(variables?.['4']).toBe('Motif un. Motif deux. · Equipe Rabotka.');
    });

    it('flattens media onto the URL + caption pair Twilio takes', async () => {
      const { provider, twilio } = makeProvider();
      await provider.sendMedia('+242069917686', {
        kind: 'image',
        url: 'https://x/img.png',
        caption: 'hello',
      });
      expect(twilio.sendWhatsAppMedia).toHaveBeenCalledWith(
        '+242069917686',
        'https://x/img.png',
        'hello',
      );
    });
  });

  describe('an absent client', () => {
    it('is NOT_CONFIGURED rather than an auth failure', async () => {
      const { provider } = makeProvider({
        sendWhatsApp: jest.fn().mockResolvedValue(null),
      } as Partial<TwilioService>);
      await expect(provider.sendText('+242069917686', 'Hi')).rejects.toThrow(
        WhatsappError,
      );
      await expect(
        provider.sendText('+242069917686', 'Hi'),
      ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', retryable: false });
    });
  });

  describe('error normalization', () => {
    // The message text is what the admin back office puts in a toast, so it is
    // passed through verbatim.
    it('keeps the provider message unchanged', async () => {
      const raw = '[Twilio 63016] Message failed — message to +242 failed';
      const { provider } = makeProvider({
        sendWhatsApp: jest
          .fn()
          .mockRejectedValue(new TwilioSendError(raw, 63016)),
      } as Partial<TwilioService>);
      await expect(
        provider.sendText('+242069917686', 'Hi'),
      ).rejects.toMatchObject({
        code: 'OUTSIDE_MESSAGING_WINDOW',
        message: raw,
        providerCode: 63016,
      });
    });

    it.each<[number, WhatsappErrorCode]>([
      [63016, 'OUTSIDE_MESSAGING_WINDOW'],
      [63024, 'INVALID_RECIPIENT'],
      [21211, 'INVALID_RECIPIENT'],
      [63018, 'RATE_LIMITED'],
      [63005, 'TEMPLATE_NOT_FOUND'],
      [20003, 'AUTH_FAILED'],
      [63038, 'SANDBOX_LIMIT_REACHED'],
      [63031, 'SENDER_IS_RECIPIENT'],
    ])('maps Twilio %i to %s', (code, expected) => {
      expect(twilioErrorCode(new TwilioSendError('x', code))).toBe(expected);
    });

    it('maps an unrecognized code to UNKNOWN and retries it once', () => {
      const err = new WhatsappError({
        code: twilioErrorCode(new TwilioSendError('x', 99999)),
        provider: 'twilio',
        message: 'x',
      });
      expect(err.code).toBe('UNKNOWN');
      expect(err.retryable).toBe(true);
    });

    it('treats a rate limit as retryable and a closed window as not', () => {
      const mk = (code: WhatsappErrorCode) =>
        new WhatsappError({ code, provider: 'twilio', message: 'x' });
      expect(mk('RATE_LIMITED').retryable).toBe(true);
      expect(mk('OUTSIDE_MESSAGING_WINDOW').retryable).toBe(false);
      expect(mk('INVALID_RECIPIENT').retryable).toBe(false);
      expect(mk('TEMPLATE_NOT_FOUND').retryable).toBe(false);
      expect(mk('AUTH_FAILED').retryable).toBe(false);
    });
  });

  describe('capabilities it does not have', () => {
    // Twilio expresses all of these only through a pre-approved Content
    // template, whose layout lives in the Twilio Console — there is nothing to
    // build from a normalized payload, so these must fail loudly rather than
    // pretend.
    it('throws WhatsappCapabilityError for interactive sends', async () => {
      const { provider } = makeProvider();
      await expect(
        provider.sendInteractiveButtons('+242069917686', {
          body: 'x',
          buttons: [{ id: '1', title: 'Yes' }],
        }),
      ).rejects.toThrow(WhatsappCapabilityError);
      await expect(
        provider.sendInteractiveList('+242069917686', {
          body: 'x',
          buttonText: 'Open',
          sections: [],
        }),
      ).rejects.toThrow(WhatsappCapabilityError);
      await expect(
        provider.sendCarousel('+242069917686', { body: 'x', cards: [] }),
      ).rejects.toThrow(WhatsappCapabilityError);
      await expect(
        provider.sendLocation('+242069917686', { latitude: 0, longitude: 0 }),
      ).rejects.toThrow(WhatsappCapabilityError);
      await expect(
        provider.sendReaction('+242069917686', 'SM1', '👍'),
      ).rejects.toThrow(WhatsappCapabilityError);
    });

    // These two deliberately do NOT throw: a missing "seen" tick costs the
    // reader nothing, and throwing would force every caller to branch.
    it('no-ops read receipts and typing without throwing', async () => {
      const { provider } = makeProvider();
      await expect(provider.markAsRead('SM1')).resolves.toBeUndefined();
      await expect(
        provider.sendTypingIndicator('SM1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('webhook signature', () => {
    it('refuses when the signature header is absent', () => {
      const { provider } = makeProvider();
      expect(provider.verifyWebhookSignature(Buffer.from(''), {})).toBe(false);
    });

    it('refuses when no auth token is configured', () => {
      const { provider } = makeProvider({
        getAuthToken: jest.fn().mockReturnValue(null),
      } as Partial<TwilioService>);
      expect(
        provider.verifyWebhookSignature(Buffer.from(''), {
          'x-twilio-signature': 'sig',
          'x-webhook-url': 'https://api.rabotka.work/api/v1/whatsapp/incoming',
        }),
      ).toBe(false);
    });
  });
});
