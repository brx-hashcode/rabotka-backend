import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { CloudProvider } from '../cloud.provider';
import { redactHeaders } from '../cloud.client';
import { cloudErrorCode } from '../cloud.errors';
import { WhatsappError, type WhatsappErrorCode } from '../../../contracts';
import type { CloudProviderConfig } from '../../../whatsapp.config';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const CONFIG: CloudProviderConfig = {
  provider: 'cloud',
  apiVersion: 'v25.0',
  phoneNumberId: '111222333',
  accessToken: 'EAAG-super-secret-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
  wabaId: '999',
};

type FetchArgs = { url: string; init: RequestInit };

/** The stub only ever receives a string URL and a string JSON body. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function stubFetch(responses: { status: number; body: unknown }[]): {
  calls: FetchArgs[];
} {
  const calls: FetchArgs[] = [];
  let i = 0;
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: asString(url), init: init ?? {} });
    const next = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      statusText: `HTTP ${next.status}`,
      json: () => Promise.resolve(next.body),
    } as Response);
  }) as typeof fetch;
  return { calls };
}

const ACCEPTED = {
  status: 200,
  body: {
    messaging_product: 'whatsapp',
    contacts: [{ input: '242069917686', wa_id: '242069917686' }],
    messages: [{ id: 'wamid.HBgMMjQy' }],
  },
};

function body(call: FetchArgs): Record<string, unknown> {
  return JSON.parse(asString(call.init.body)) as Record<string, unknown>;
}

describe('CloudProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('reports the capabilities Twilio lacks', () => {
    const provider = new CloudProvider(CONFIG);
    expect(provider.name).toBe('cloud');
    expect(provider.capabilities.typingIndicator).toBe(true);
    expect(provider.capabilities.readReceipts).toBe(true);
    expect(provider.capabilities.interactiveButtons).toBe(true);
    // Still false: a carousel needs an approved carousel template.
    expect(provider.capabilities.carousel).toBe(false);
    expect(provider.capabilities.freeformOutsideWindow).toBe(false);
  });

  describe('transport', () => {
    it('posts to the versioned phone-number endpoint with a bearer token', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendText('+242069917686', 'Bonjour');

      expect(calls[0].url).toBe(
        'https://graph.facebook.com/v25.0/111222333/messages',
      );
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer EAAG-super-secret-token');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('returns the wamid as the provider message id', async () => {
      stubFetch([ACCEPTED]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'Bonjour'),
      ).resolves.toMatchObject({
        providerMessageId: 'wamid.HBgMMjQy',
        provider: 'cloud',
      });
    });

    it('treats a 200 with no message id as a failure, not a delivery', async () => {
      stubFetch([{ status: 200, body: { messaging_product: 'whatsapp' } }]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    });

    it('does not retry — that layer belongs to BullMQ', async () => {
      const { calls } = stubFetch([
        { status: 500, body: { error: { message: 'oops', code: 1 } } },
      ]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toThrow(WhatsappError);
      expect(calls).toHaveLength(1);
    });

    it('reports a timeout as a retryable transport error', async () => {
      global.fetch = jest.fn(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }) as typeof fetch;
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
    });
  });

  describe('wire format', () => {
    it('sends text with a digits-only recipient', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendText('+242 06 99 17 686', 'Bonjour');
      expect(body(calls[0])).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '242069917686',
        type: 'text',
        text: { body: 'Bonjour' },
      });
    });

    it('sends a template by name and language', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendTemplate(
        '+242069917686',
        'otp',
        '123456',
      );
      expect(body(calls[0])).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '242069917686',
        type: 'template',
        template: {
          name: 'rabotka_otp',
          language: { code: 'fr' },
          // AUTHENTICATION: the code goes in the body and again in the
          // copy-code button.
          components: [
            { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: '123456' }],
            },
          ],
        },
      });
    });

    it('sends an image with a caption', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendMedia('+242069917686', {
        kind: 'image',
        url: 'https://x/i.png',
        caption: 'hello',
      });
      expect(body(calls[0])).toMatchObject({
        type: 'image',
        image: { link: 'https://x/i.png', caption: 'hello' },
      });
    });

    it('omits the caption on audio, which Meta rejects', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendMedia('+242069917686', {
        kind: 'audio',
        url: 'https://x/a.ogg',
        caption: 'ignored',
      });
      expect(body(calls[0]).audio).toEqual({ link: 'https://x/a.ogg' });
    });

    it('sends reply buttons', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendInteractiveButtons('+242069917686', {
        body: 'Choisir',
        buttons: [{ id: '1', title: 'Oui' }],
      });
      expect(body(calls[0])).toMatchObject({
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: 'Choisir' },
          action: {
            buttons: [{ type: 'reply', reply: { id: '1', title: 'Oui' } }],
          },
        },
      });
    });

    it('refuses more than three buttons before calling Meta', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await expect(
        new CloudProvider(CONFIG).sendInteractiveButtons('+242069917686', {
          body: 'x',
          buttons: [1, 2, 3, 4].map((n) => ({
            id: String(n),
            title: `B${n}`,
          })),
        }),
      ).rejects.toThrow(/must number 1-3/);
      expect(calls).toHaveLength(0);
    });

    it('carries biz_opaque_callback_data so a status can be correlated', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendText('+242069917686', 'x', {
        internalMessageId: 'msg-7',
      });
      expect(body(calls[0]).biz_opaque_callback_data).toBe('msg-7');
    });
  });

  describe('read receipts and typing', () => {
    it('marks read without a typing indicator', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).markAsRead('wamid.X');
      expect(body(calls[0])).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.X',
      });
    });

    it('adds the typing indicator to the same read payload', async () => {
      const { calls } = stubFetch([ACCEPTED]);
      await new CloudProvider(CONFIG).sendTypingIndicator('wamid.X');
      expect(body(calls[0])).toEqual({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: 'wamid.X',
        typing_indicator: { type: 'text' },
      });
    });

    it('swallows a failure — a missing tick must not fail a caller', async () => {
      stubFetch([
        { status: 400, body: { error: { message: 'no', code: 100 } } },
      ]);
      await expect(
        new CloudProvider(CONFIG).markAsRead('wamid.X'),
      ).resolves.toBeUndefined();
    });
  });

  describe('error normalization', () => {
    it.each<[number, WhatsappErrorCode]>([
      [131047, 'OUTSIDE_MESSAGING_WINDOW'],
      [131026, 'INVALID_RECIPIENT'],
      [130429, 'RATE_LIMITED'],
      [80007, 'RATE_LIMITED'],
      [132001, 'TEMPLATE_NOT_FOUND'],
      [190, 'AUTH_FAILED'],
    ])('maps Meta %i to %s', (code, expected) => {
      expect(cloudErrorCode(code)).toBe(expected);
    });

    it('maps an unrecognized code to UNKNOWN', () => {
      expect(cloudErrorCode(424242)).toBe('UNKNOWN');
    });

    it('surfaces the Meta code and message on a rejected send', async () => {
      stubFetch([
        {
          status: 400,
          body: {
            error: {
              message: 'Re-engagement message',
              code: 131047,
              error_subcode: 2494055,
              error_data: { details: 'outside the 24 hour window' },
            },
          },
        },
      ]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toMatchObject({
        code: 'OUTSIDE_MESSAGING_WINDOW',
        providerCode: 131047,
        retryable: false,
        message:
          '[Cloud 131047/2494055] Re-engagement message — outside the 24 hour window',
      });
    });

    it('treats an unrecognized 5xx as retryable rather than UNKNOWN', async () => {
      stubFetch([
        {
          status: 503,
          body: { error: { message: 'unavailable', code: 999999 } },
        },
      ]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    });

    it('handles a non-Graph error body, e.g. a gateway page', async () => {
      stubFetch([{ status: 502, body: '<html>bad gateway</html>' }]);
      await expect(
        new CloudProvider(CONFIG).sendText('+242069917686', 'x'),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        message: '[Cloud HTTP 502] HTTP 502',
      });
    });
  });

  describe('webhook signature', () => {
    // sha256 HMAC of `{"a":1}` keyed with 'app-secret'.
    const raw = Buffer.from('{"a":1}', 'utf8');
    const provider = new CloudProvider(CONFIG);
    const valid = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;

    it('accepts a correct signature', () => {
      expect(
        provider.verifyWebhookSignature(raw, {
          'x-hub-signature-256': valid,
        }),
      ).toBe(true);
    });

    it('rejects a tampered body', () => {
      expect(
        provider.verifyWebhookSignature(Buffer.from('{"a":2}', 'utf8'), {
          'x-hub-signature-256': valid,
        }),
      ).toBe(false);
    });

    it('rejects a re-serialized body', () => {
      // The exact failure `rawBody: true` exists to prevent: same JSON value,
      // different bytes.
      const reserialized = Buffer.from(JSON.stringify({ a: 1 }, null, 2));
      expect(
        provider.verifyWebhookSignature(reserialized, {
          'x-hub-signature-256': valid,
        }),
      ).toBe(false);
    });

    it('rejects a missing header', () => {
      expect(provider.verifyWebhookSignature(raw, {})).toBe(false);
    });

    it('rejects a header without the sha256= prefix', () => {
      expect(
        provider.verifyWebhookSignature(raw, {
          'x-hub-signature-256': valid.slice('sha256='.length),
        }),
      ).toBe(false);
    });

    it('rejects a signature made with the wrong secret', () => {
      const wrong = `sha256=${createHmac('sha256', 'not-the-secret').update(raw).digest('hex')}`;
      expect(
        provider.verifyWebhookSignature(raw, { 'x-hub-signature-256': wrong }),
      ).toBe(false);
    });

    it('rejects a truncated signature without throwing', () => {
      // timingSafeEqual throws on a length mismatch, which would turn a
      // malformed header into a 500 rather than a 403.
      expect(() =>
        provider.verifyWebhookSignature(raw, {
          'x-hub-signature-256': 'sha256=abc',
        }),
      ).not.toThrow();
    });
  });

  describe('challenge token', () => {
    it('accepts the configured token and rejects anything else', () => {
      const provider = new CloudProvider(CONFIG);
      expect(provider.verifyChallengeToken('verify-token')).toBe(true);
      expect(provider.verifyChallengeToken('verify-token-x')).toBe(false);
      expect(provider.verifyChallengeToken('')).toBe(false);
    });
  });
});

describe('redactHeaders', () => {
  it('never lets a bearer token or signature reach a log line', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer EAAG-super-secret-token',
        'X-Hub-Signature-256': 'sha256=deadbeef',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Authorization: '[redacted]',
      'X-Hub-Signature-256': '[redacted]',
      'Content-Type': 'application/json',
    });
  });
});
