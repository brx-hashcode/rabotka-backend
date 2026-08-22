import { deriveKey } from '../kyc-key';

const BASE = 'https://files.rabotka.cg';
const BUCKET = 'rabotka-files';

/**
 * The one function in the backfill that can cause data loss.
 *
 * A wrong key copies the wrong object into the private bucket and then, with
 * --delete-source, deletes the right one. An identity document has no second
 * copy: the person would have to redo their whole file, and the product has no
 * re-submission path. So this returns null far more readily than it guesses.
 */
describe('deriveKey', () => {
  it('strips the public base', () => {
    expect(deriveKey(`${BASE}/kyc-documents/1700_ab.jpg`, BASE, BUCKET)).toBe(
      'kyc-documents/1700_ab.jpg',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(
      deriveKey(`${BASE}/kyc-documents/a.jpg`, `${BASE}///`, BUCKET),
    ).toBe('kyc-documents/a.jpg');
  });

  it('decodes percent-encoded paths', () => {
    expect(
      deriveKey(`${BASE}/kyc-documents/carte%20identite.jpg`, BASE, BUCKET),
    ).toBe('kyc-documents/carte identite.jpg');
  });

  it('drops a query string rather than baking it into the key', () => {
    expect(deriveKey(`${BASE}/kyc-documents/a.jpg?v=2`, BASE, BUCKET)).toBe(
      'kyc-documents/a.jpg',
    );
  });

  it('reads a signed url, whose key sits in the path', () => {
    // Rows written before backfill-public-image-urls.ts ran still hold these.
    const signed =
      `https://acct.r2.cloudflarestorage.com/${BUCKET}/kyc-documents/a.jpg` +
      '?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
    expect(deriveKey(signed, BASE, BUCKET)).toBe('kyc-documents/a.jpg');
  });

  it('keeps the first segment when it is not the bucket name', () => {
    const signed =
      'https://acct.r2.cloudflarestorage.com/kyc-documents/a.jpg' +
      '?X-Amz-Signature=deadbeef';
    expect(deriveKey(signed, BASE, BUCKET)).toBe('kyc-documents/a.jpg');
  });

  it.each([
    ['not a url at all', 'kyc-documents/a.jpg'],
    ['an empty string', ''],
    ['a url with no path', 'https://files.rabotka.cg'],
    ['a bucket-only path', `https://acct.r2.cloudflarestorage.com/${BUCKET}`],
  ])('returns null for %s rather than guessing', (_label, url) => {
    expect(deriveKey(url, BASE, BUCKET)).toBeNull();
  });

  it('does not confuse a base that is a prefix of another host', () => {
    // `files.rabotka.cg.evil.com` starts with the base as a STRING but is a
    // different host. Requiring the `/` separator rejects it, and the
    // signed-url branch then declines it too for having no signature.
    expect(
      deriveKey('https://files.rabotka.cg.evil.com/x.jpg', BASE, BUCKET),
    ).toBeNull();
  });

  it('refuses an unsigned url on an unrelated host', () => {
    // Without the X-Amz-Signature check, ANY url yields a plausible key.
    expect(
      deriveKey('https://example.com/kyc-documents/a.jpg', BASE, BUCKET),
    ).toBeNull();
  });
});
