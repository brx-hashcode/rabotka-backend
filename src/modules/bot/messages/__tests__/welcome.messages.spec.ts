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

  it.each([
    ['platform', welcomePlatformMessage()],
    ['unregistered', welcomeUnregisteredMessage()],
  ])('leaves the %s card no billed way out', (_label, reply) => {
    // The point of the change: both cards used to fall back to an approved
    // MARKETING template, so any refusal became a paid message. The fallback
    // is now plain text, which is free — and still carries the link, so the
    // person can reach the app even without a button.
    const payload = card(reply);
    expect(payload).not.toHaveProperty('fallbackTemplate');
    expect(String(payload.fallbackText)).toContain('https://rabotka.work');
  });

  it('says what Rabotka is, since there is no longer a picture to', () => {
    const body = String(card(welcomePlatformMessage()).body);
    expect(body).toContain('Rabotka');
    expect(body.split('\n').length).toBeGreaterThanOrEqual(2);
  });
});
