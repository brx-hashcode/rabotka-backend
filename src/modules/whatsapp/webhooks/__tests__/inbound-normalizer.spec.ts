import {
  normalizeCloudWebhook,
  normalizeTwilioWebhook,
  toBotInput,
} from '../inbound-normalizer';
import type {
  CloudStatus,
  CloudWebhookBody,
} from '../../providers/cloud/cloud.types';

function cloudBody(
  overrides: Partial<CloudWebhookBody> = {},
): CloudWebhookBody {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [
                { wa_id: '242069917686', profile: { name: 'Fariol' } },
              ],
              messages: [
                {
                  from: '242069917686',
                  id: 'wamid.1',
                  timestamp: '1754870400',
                  type: 'text',
                  text: { body: 'Bonjour' },
                },
              ],
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('normalizeCloudWebhook', () => {
  it('normalizes a text message', () => {
    const [event] = normalizeCloudWebhook(cloudBody());
    expect(event).toEqual({
      kind: 'message',
      from: '+242069917686',
      providerMessageId: 'wamid.1',
      timestamp: new Date(1754870400 * 1000),
      content: { type: 'text', text: 'Bonjour' },
      provider: 'cloud',
      profileName: 'Fariol',
    });
  });

  it('reads the timestamp as Unix seconds, not milliseconds', () => {
    // `new Date('1754870400')` would be Invalid Date, and Number * 1 would put
    // the event in 1970 — either way the 24h window computation breaks.
    const [event] = normalizeCloudWebhook(cloudBody());
    expect(event.timestamp.getUTCFullYear()).toBe(2025);
  });

  it('gives the sender a canonical +E.164 address', () => {
    // Cloud sends bare digits; everything downstream matches on +242…
    const [event] = normalizeCloudWebhook(cloudBody());
    expect(event.kind === 'message' && event.from).toBe('+242069917686');
  });

  it('walks EVERY entry, change, message and status', () => {
    // The failure this guards: reading entry[0].changes[0] drops the rest, and
    // Meta only batches under load — exactly when losing messages matters.
    const events = normalizeCloudWebhook({
      entry: [
        {
          id: 'e1',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '242001',
                    id: 'm1',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'a' },
                  },
                  {
                    from: '242002',
                    id: 'm2',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'b' },
                  },
                ],
              },
            },
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'm0',
                    status: 'delivered',
                    timestamp: '1',
                    recipient_id: '242003',
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'e2',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '242004',
                    id: 'm3',
                    timestamp: '1',
                    type: 'text',
                    text: { body: 'c' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(3);
    expect(events.filter((e) => e.kind === 'status')).toHaveLength(1);
  });

  it('normalizes an interactive button reply to its id', () => {
    const [event] = normalizeCloudWebhook({
      entry: [
        {
          id: 'e',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '242001',
                    id: 'm1',
                    timestamp: '1',
                    type: 'interactive',
                    interactive: {
                      type: 'button_reply',
                      button_reply: { id: '2', title: 'Refuser' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event.kind === 'message' && event.content).toEqual({
      type: 'interactive_reply',
      replyId: '2',
      title: 'Refuser',
    });
  });

  it('normalizes a template quick-reply tap identically to an interactive one', () => {
    // Meta uses a different shape (`button`) for a quick reply on a TEMPLATE
    // than for one on an interactive message. The bot flows must not be able to
    // tell them apart — Twilio surfaces both as ButtonPayload.
    const [event] = normalizeCloudWebhook({
      entry: [
        {
          id: 'e',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '242001',
                    id: 'm1',
                    timestamp: '1',
                    type: 'button',
                    button: { payload: '1', text: 'Postuler' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event.kind === 'message' && event.content).toEqual({
      type: 'interactive_reply',
      replyId: '1',
      title: 'Postuler',
    });
  });

  it('carries an unmodelled type through rather than dropping it', () => {
    const [event] = normalizeCloudWebhook({
      entry: [
        {
          id: 'e',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  { from: '242001', id: 'm1', timestamp: '1', type: 'sticker' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event.kind === 'message' && event.content).toEqual({
      type: 'unsupported',
      rawType: 'sticker',
    });
  });

  it('normalizes a failed status with its error mapped to an internal code', () => {
    const [event] = normalizeCloudWebhook({
      entry: [
        {
          id: 'e',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.9',
                    status: 'failed',
                    timestamp: '1754870400',
                    recipient_id: '242069917686',
                    biz_opaque_callback_data: 'msg-7',
                    errors: [
                      {
                        code: 131047,
                        title: 'Re-engagement message',
                        error_data: { details: 'outside the window' },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event).toEqual({
      kind: 'status',
      providerMessageId: 'wamid.9',
      status: 'failed',
      timestamp: new Date(1754870400 * 1000),
      provider: 'cloud',
      error: {
        code: 'OUTSIDE_MESSAGING_WINDOW',
        providerCode: 131047,
        message: 'outside the window',
      },
      internalMessageId: 'msg-7',
      to: '+242069917686',
    });
  });

  it('skips a status value it does not recognize rather than guessing', () => {
    // CloudStatus.status is the closed union Meta documents, so this value has
    // to be forced past the compiler — which is the point. The type describes
    // what Meta documents; the runtime receives whatever Meta actually sends,
    // and inventing a delivery state for a new one would corrupt the telemetry
    // it feeds.
    const unknownStatus = {
      id: 'm',
      status: 'deleted',
      timestamp: '1',
      recipient_id: '1',
    } as unknown as CloudStatus;

    const events = normalizeCloudWebhook({
      entry: [
        {
          id: 'e',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [unknownStatus],
              },
            },
          ],
        },
      ],
    });
    expect(events).toEqual([]);
  });

  it('returns nothing for an empty or unfamiliar envelope', () => {
    expect(normalizeCloudWebhook({})).toEqual([]);
    expect(normalizeCloudWebhook({ entry: [] })).toEqual([]);
    expect(normalizeCloudWebhook({ entry: [{ id: 'e' }] })).toEqual([]);
  });
});

describe('normalizeTwilioWebhook', () => {
  it('normalizes an inbound text and strips the channel prefix', () => {
    const [event] = normalizeTwilioWebhook({
      From: 'whatsapp:+24200000001',
      Body: 'Hello',
      MessageSid: 'SM123',
    });
    expect(event).toMatchObject({
      kind: 'message',
      from: '+24200000001',
      providerMessageId: 'SM123',
      provider: 'twilio',
      content: { type: 'text', text: 'Hello' },
    });
  });

  it('prefers ButtonPayload and normalizes it like a Cloud reply', () => {
    const [event] = normalizeTwilioWebhook({
      From: 'whatsapp:+24200000001',
      ButtonPayload: '1',
      ButtonText: 'Postuler',
      Body: 'Postuler',
      MessageSid: 'SM1',
    });
    expect(event.kind === 'message' && event.content).toEqual({
      type: 'interactive_reply',
      replyId: '1',
      title: 'Postuler',
    });
  });

  it('recognizes a delivery status callback rather than treating it as a message', () => {
    const [event] = normalizeTwilioWebhook({
      MessageStatus: 'delivered',
      MessageSid: 'SM1',
      To: 'whatsapp:+24200000001',
    });
    expect(event).toMatchObject({
      kind: 'status',
      status: 'delivered',
      providerMessageId: 'SM1',
      to: '+24200000001',
    });
  });

  it("maps Twilio's undelivered onto the shared failed status", () => {
    const [event] = normalizeTwilioWebhook({
      MessageStatus: 'undelivered',
      MessageSid: 'SM1',
    });
    expect(event.kind === 'status' && event.status).toBe('failed');
  });

  it('returns nothing when there is no From and no status', () => {
    expect(normalizeTwilioWebhook({})).toEqual([]);
  });
});

describe('toBotInput', () => {
  it('gives the bot the reply id for an interactive tap', () => {
    // The bot graph routes on numeric tokens, and this is the value Twilio's
    // ButtonPayload already produced — so both providers drive the same flows.
    expect(
      toBotInput({
        kind: 'message',
        from: '+242001',
        providerMessageId: 'm',
        timestamp: new Date(),
        provider: 'cloud',
        content: { type: 'interactive_reply', replyId: '1' },
      }),
    ).toBe('1');
  });

  it('gives the bot the text of a text message', () => {
    expect(
      toBotInput({
        kind: 'message',
        from: '+242001',
        providerMessageId: 'm',
        timestamp: new Date(),
        provider: 'cloud',
        content: { type: 'text', text: 'Bonjour' },
      }),
    ).toBe('Bonjour');
  });

  it('has nothing for a status event', () => {
    expect(
      toBotInput({
        kind: 'status',
        providerMessageId: 'm',
        status: 'delivered',
        timestamp: new Date(),
        provider: 'cloud',
      }),
    ).toBeNull();
  });

  const msg = (content: unknown) =>
    ({
      kind: 'message',
      from: '+242001',
      providerMessageId: 'm',
      timestamp: new Date(),
      provider: 'cloud',
      content,
    }) as Parameters<typeof toBotInput>[0];

  describe('things nobody typed', () => {
    // The bug this covers: `toBotInput` returned '' for these, and the caller
    // only skips on null — so an unregistered number received the entire
    // welcome card for reacting to a message, twice, hours apart, without
    // sending anything.

    it('does not answer a reaction', () => {
      expect(
        toBotInput(msg({ type: 'reaction', emoji: '👍', targetMessageId: 'x' })),
      ).toBeNull();
    });

    it.each(['system', 'order', 'request_welcome', 'ephemeral', 'unknown'])(
      'does not answer a %s notification',
      (rawType) => {
        expect(toBotInput(msg({ type: 'unsupported', rawType }))).toBeNull();
      },
    );

    it('returns null, not an empty string', () => {
      // The distinction is the whole bug: handleMessage checks `=== null`, so
      // '' is treated as a real message with no text.
      const out = toBotInput(
        msg({ type: 'reaction', emoji: '👍', targetMessageId: 'x' }),
      );
      expect(out).not.toBe('');
      expect(out).toBeNull();
    });
  });

  describe('things a person did send', () => {
    it('still answers a sticker, so the reader is not ignored', () => {
      expect(toBotInput(msg({ type: 'unsupported', rawType: 'sticker' }))).toBe(
        '',
      );
    });

    it('still answers a contact card', () => {
      expect(
        toBotInput(msg({ type: 'unsupported', rawType: 'contacts' })),
      ).toBe('');
    });

    it('still answers a voice note', () => {
      expect(toBotInput(msg({ type: 'audio', mediaId: 'a' }))).toBe('');
    });

    it('still answers a shared location', () => {
      expect(
        toBotInput(
          msg({ type: 'location', latitude: 1, longitude: 2 }),
        ),
      ).toBe('');
    });
  });
});
