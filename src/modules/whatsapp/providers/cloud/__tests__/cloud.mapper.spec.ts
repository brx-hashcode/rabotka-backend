import {
  buildComponents,
  toProviderAddress,
  toTemplatePayload,
  toTemplatePayloadFromParams,
} from '../cloud.mapper';
import { WHATSAPP_TEMPLATES } from '../../../../../common/constants/whatsapp-templates';

describe('toProviderAddress (cloud)', () => {
  // Cloud accepts a `+`-prefixed number and then silently fails to deliver,
  // which is the worst failure mode available, so this is not cosmetic.
  it.each([
    ['canonical', '+242069917686'],
    ['spaced as a human writes it', '+242 06 99 17 686'],
    ['dashed', '+242-06-99-17-686'],
    ['no plus', '242069917686'],
    ['00 international prefix', '00242069917686'],
    ['whatsapp-prefixed (inbound webhook)', 'whatsapp:+242069917686'],
  ])('strips %s down to bare digits', (_label, input) => {
    expect(toProviderAddress(input)).toBe('242069917686');
  });

  it('handles an Airtel 05 number', () => {
    expect(toProviderAddress('+242 05 512 3456')).toBe('242055123456');
  });

  it('handles a non-CG number', () => {
    expect(toProviderAddress('+33 6 12 34 56 78')).toBe('33612345678');
    expect(toProviderAddress('+1 (415) 523-8886')).toBe('14155238886');
  });

  it('never emits a plus or a channel prefix', () => {
    for (const input of ['+242069917686', 'whatsapp:+242069917686']) {
      expect(toProviderAddress(input)).not.toContain('+');
      expect(toProviderAddress(input)).not.toContain('whatsapp');
    }
  });
});

describe('buildComponents', () => {
  it('orders body parameters numerically even when the map is built out of order', () => {
    // applicationAccepted literally writes {'3', '1', '2'} — the button
    // variable first. JavaScript already enumerates integer-like keys in
    // ascending order, so this passes for free; the assertion pins the
    // behaviour Meta depends on (positional matching) rather than the mechanism.
    const variables = WHATSAPP_TEMPLATES.applicationAccepted.variables({
      employerName: 'Alice',
      offerTitle: 'Plomberie',
    });
    expect(Object.keys(variables)).toEqual(['1', '2', '3']);

    const components = buildComponents('applicationAccepted', variables);
    const body = components.find((c) => c.type === 'body');
    expect(body?.parameters).toEqual([
      { type: 'text', text: 'Alice' },
      { type: 'text', text: 'Plomberie' },
    ]);
  });

  it('sorts numerically rather than lexicographically', () => {
    // '10' must follow '9', not precede it. No current template reaches 10
    // variables, so this drives buildComponents directly — and on a template
    // with no urlSuffixVar, so every key lands in the body.
    const components = buildComponents('viewWorkerPortfolio', {
      '1': 'a',
      '2': 'b',
      '10': 'j',
      '9': 'i',
    });
    const body = components.find((c) => c.type === 'body');
    expect(body?.parameters.map((p) => ('text' in p ? p.text : ''))).toEqual([
      'a',
      'b',
      'i',
      'j',
    ]);
  });

  it('routes the URL-suffix variable to a button component, not the body', () => {
    const variables = WHATSAPP_TEMPLATES.reminder24h.variables({
      offerTitle: 'Plomberie',
      date: '12/08',
      address: 'Brazzaville',
      amount: '25000',
      employerName: 'Alice',
      employerPhone: '+242069917686',
      cancellationThresholdHours: '4',
      penaltyFcfa: '5000',
      applicationId: 'app-1',
    });
    const components = buildComponents('reminder24h', variables);

    const body = components.find((c) => c.type === 'body');
    // 9 variables, one of which fills the button URL.
    expect(body?.parameters).toHaveLength(8);
    expect(body?.parameters).not.toContainEqual({
      type: 'text',
      text: 'app-1',
    });

    expect(components.find((c) => c.type === 'button')).toEqual({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: 'app-1' }],
    });
  });

  it('emits only a button for a template whose single variable is the suffix', () => {
    // kycPendingMenu's one variable IS the shortlink destination.
    const components = buildComponents(
      'kycPendingMenu',
      WHATSAPP_TEMPLATES.kycPendingMenu.variables(),
    );
    expect(components.map((c) => c.type)).toEqual(['button']);
  });

  it('emits nothing for a template with no variables', () => {
    expect(
      buildComponents(
        'welcomeUnregisteredCard',
        WHATSAPP_TEMPLATES.welcomeUnregisteredCard.variables(),
      ),
    ).toEqual([]);
  });

  it('emits only a body for a template with no CTA button', () => {
    const components = buildComponents(
      'otp',
      WHATSAPP_TEMPLATES.otp.variables('123456'),
    );
    expect(components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
    ]);
  });
});

describe('toTemplatePayload', () => {
  it('produces the exact Graph body for a template send', () => {
    expect(
      toTemplatePayloadFromParams('+242 06 99 17 686', 'otp', '123456'),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '242069917686',
      type: 'template',
      template: {
        name: 'rabotka_otp',
        language: { code: 'fr' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
        ],
      },
    });
  });

  it('omits components entirely when there are none', () => {
    // Meta rejects `components: []` on some template shapes, so the key is
    // absent rather than empty.
    const payload = toTemplatePayload(
      '+242069917686',
      'welcomeUnregisteredCard',
      {},
    );
    expect(payload.template).not.toHaveProperty('components');
  });

  it('carries the internal id as biz_opaque_callback_data', () => {
    const payload = toTemplatePayload(
      '+242069917686',
      'otp',
      { '1': '1' },
      {
        internalMessageId: 'msg-42',
      },
    );
    expect(payload.biz_opaque_callback_data).toBe('msg-42');
  });

  it('omits biz_opaque_callback_data when no internal id is given', () => {
    const payload = toTemplatePayload('+242069917686', 'otp', { '1': '1' });
    expect(payload).not.toHaveProperty('biz_opaque_callback_data');
  });

  it('honours a language override', () => {
    const payload = toTemplatePayload(
      '+242069917686',
      'otp',
      { '1': '1' },
      { languageOverride: 'en_US' },
    );
    expect(payload.template.language).toEqual({ code: 'en_US' });
  });

  it('defaults every template to French', () => {
    const payload = toTemplatePayload('+242069917686', 'kyc', { '1': 'A' });
    expect(payload.template.language).toEqual({ code: 'fr' });
  });
});
