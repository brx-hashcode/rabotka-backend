import {
  welcomePlatformMessage,
  welcomeUnregisteredMessage,
} from '../welcome.messages';

/** The `[CTA:]<json>` payload a card encodes to. */
function card(reply: string): Record<string, unknown> {
  expect(reply.startsWith('[CTA:]')).toBe(true);
  return JSON.parse(reply.slice('[CTA:]'.length)) as Record<string, unknown>;
}

describe('the welcome cards', () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * The header image must be a LINK. Sending it as an uploaded media id is
   * refused by Graph with 131008, "header image must contain link" — verified
   * on a live send, after that exact change shipped to production and made
   * every welcome fall through to the approved MARKETING template, which is
   * billed. The card carries a URL; the provider does the rest.
   */
  it.each([
    ['platform', welcomePlatformMessage()],
    ['unregistered', welcomeUnregisteredMessage()],
  ])('gives the %s card an image URL for its header', (_label, reply) => {
    const url = card(reply).imageUrl;
    expect(typeof url).toBe('string');
    expect(String(url)).toMatch(/^https:\/\//u);
  });

  it.each([
    ['platform', welcomePlatformMessage()],
    ['unregistered', welcomeUnregisteredMessage()],
  ])('keeps the button on the %s card', (_label, reply) => {
    // The button is the whole reason for this message type: a bare link in
    // text does not open WhatsApp's in-app browser.
    const payload = card(reply);
    expect(payload.buttonText).toEqual(expect.any(String));
    expect(String(payload.buttonText).length).toBeGreaterThan(0);
    expect(payload.path).toEqual(expect.any(String));
  });

  it('still names a billed template as the last resort', () => {
    // Keeping it is right — a card that cannot be sent at all should still
    // reach the person. It is only the FIRST choice that must stay free.
    expect(card(welcomePlatformMessage()).fallbackTemplate).toBe(
      'welcomePlatform',
    );
  });

  it('says what Rabotka is, since there is no longer a picture to', () => {
    const body = String(card(welcomePlatformMessage()).body);
    expect(body).toContain('Rabotka');
    expect(body.split('\n').length).toBeGreaterThanOrEqual(2);
  });
});
