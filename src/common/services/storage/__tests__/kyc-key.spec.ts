import { deriveKey, isKycKey } from '../kyc-key';

const BASE = 'https://files.rabotka.cg';
const PUBLIC_BUCKET = 'rabotka-files';
const KYC_BUCKET = 'rabotka-kyc-document';
const BUCKETS = [PUBLIC_BUCKET, KYC_BUCKET];
const ACCT = 'acct.r2.cloudflarestorage.com';

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
    expect(
      deriveKey(`${BASE}/kyc-documents/1700_ab.jpg`, BASE, BUCKETS),
    ).toEqual({ key: 'kyc-documents/1700_ab.jpg', bucket: null });
  });

  it('tolerates a trailing slash on the base', () => {
    expect(
      deriveKey(`${BASE}/kyc-documents/a.jpg`, `${BASE}///`, BUCKETS),
    ).toEqual({ key: 'kyc-documents/a.jpg', bucket: null });
  });

  it('decodes percent-encoded paths', () => {
    expect(
      deriveKey(`${BASE}/kyc-documents/carte%20identite.jpg`, BASE, BUCKETS),
    ).toEqual({ key: 'kyc-documents/carte identite.jpg', bucket: null });
  });

  it('drops a query string rather than baking it into the key', () => {
    expect(deriveKey(`${BASE}/kyc-documents/a.jpg?v=2`, BASE, BUCKETS)).toEqual(
      {
        key: 'kyc-documents/a.jpg',
        bucket: null,
      },
    );
  });

  it('reads a path-style signed url, whose bucket leads the path', () => {
    const signed =
      `https://${ACCT}/${PUBLIC_BUCKET}/kyc-documents/a.jpg` +
      '?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
    expect(deriveKey(signed, BASE, BUCKETS)).toEqual({
      key: 'kyc-documents/a.jpg',
      bucket: PUBLIC_BUCKET,
    });
  });

  it('reads a path-style signed url naming the KYC bucket', () => {
    // The regression. The earlier version was given only the PUBLIC bucket
    // name, so it did not recognise this leading segment and returned
    // `rabotka-kyc-document/kyc-documents/a.jpg` — a key that exists nowhere.
    const signed =
      `https://${ACCT}/${KYC_BUCKET}/kyc-documents/a.jpg` +
      '?X-Amz-Signature=deadbeef';
    expect(deriveKey(signed, BASE, BUCKETS)).toEqual({
      key: 'kyc-documents/a.jpg',
      bucket: KYC_BUCKET,
    });
  });

  it('reads a virtual-hosted signed url, whose bucket is in the hostname', () => {
    // The shape the SDK actually emits today: endpoint is the account, and the
    // bucket becomes a subdomain. The whole path is the key.
    const signed =
      `https://${KYC_BUCKET}.${ACCT}/kyc-documents/a.jpg` +
      '?X-Amz-Signature=deadbeef&X-Amz-Expires=3600';
    expect(deriveKey(signed, BASE, BUCKETS)).toEqual({
      key: 'kyc-documents/a.jpg',
      bucket: KYC_BUCKET,
    });
  });

  it('does not strip a path segment when the bucket is in the hostname', () => {
    // A virtual-hosted url whose key happens to START with a bucket name. The
    // bucket has already been accounted for by the host, so stripping again
    // would eat a real folder.
    const signed =
      `https://${KYC_BUCKET}.${ACCT}/${PUBLIC_BUCKET}/a.jpg` +
      '?X-Amz-Signature=deadbeef';
    expect(deriveKey(signed, BASE, BUCKETS)).toEqual({
      key: `${PUBLIC_BUCKET}/a.jpg`,
      bucket: KYC_BUCKET,
    });
  });

  it('keeps the first segment when it is not a known bucket name', () => {
    const signed =
      `https://${ACCT}/kyc-documents/a.jpg` + '?X-Amz-Signature=deadbeef';
    expect(deriveKey(signed, BASE, BUCKETS)).toEqual({
      key: 'kyc-documents/a.jpg',
      bucket: null,
    });
  });

  it('ignores blank entries in the bucket list', () => {
    const signed =
      `https://${ACCT}/${KYC_BUCKET}/kyc-documents/a.jpg` +
      '?X-Amz-Signature=deadbeef';
    expect(deriveKey(signed, BASE, ['', '  ', KYC_BUCKET])).toEqual({
      key: 'kyc-documents/a.jpg',
      bucket: KYC_BUCKET,
    });
  });

  it.each([
    ['not a url at all', 'kyc-documents/a.jpg'],
    ['an empty string', ''],
    ['a url with no path', 'https://files.rabotka.cg'],
    ['a bucket-only path', `https://${ACCT}/${PUBLIC_BUCKET}`],
  ])('returns null for %s rather than guessing', (_label, url) => {
    expect(deriveKey(url, BASE, BUCKETS)).toBeNull();
  });

  it('does not confuse a base that is a prefix of another host', () => {
    // `files.rabotka.cg.evil.com` starts with the base as a STRING but is a
    // different host. Requiring the `/` separator rejects it, and the
    // signed-url branch then declines it too for having no signature.
    expect(
      deriveKey('https://files.rabotka.cg.evil.com/x.jpg', BASE, BUCKETS),
    ).toBeNull();
  });

  it('refuses an unsigned url on an unrelated host', () => {
    // Without the X-Amz-Signature check, ANY url yields a plausible key.
    expect(
      deriveKey('https://example.com/kyc-documents/a.jpg', BASE, BUCKETS),
    ).toBeNull();
  });
});

/**
 * Guards the client-supplied key hint. Without it `POST /profile` would accept
 * any key a caller named and hand back a signed url for it.
 */
describe('isKycKey', () => {
  it.each(['kyc-documents/1700_ab.jpg', 'kyc-verification/1700_cd.png'])(
    'accepts %s',
    (key) => {
      expect(isKycKey(key)).toBe(true);
    },
  );

  it.each([
    ['an empty string', ''],
    ['an absolute path', '/kyc-documents/a.jpg'],
    ['another folder entirely', 'avatars/a.png'],
    ['a folder that merely starts the same way', 'kyc-documentsX/a.jpg'],
    ['a traversal', 'kyc-documents/../avatars/a.png'],
    ['a bare dot segment', 'kyc-documents/./a.jpg'],
    ['a doubled slash', 'kyc-documents//a.jpg'],
    ['the prefix with nothing after it', 'kyc-documents/'],
  ])('rejects %s', (_label, key) => {
    expect(isKycKey(key)).toBe(false);
  });
});
