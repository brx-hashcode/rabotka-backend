import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Prefix on every client secret.
 *
 * Not decoration: it makes a leaked secret greppable. GitHub's secret scanning,
 * and any `git-secrets` rule a partner runs, key off a fixed prefix — without
 * one, 43 characters of base64url is indistinguishable from a build hash and
 * gets committed forever.
 */
const SECRET_PREFIX = 'rbk_sk_';

/** Same idea, for the public half. Distinguishes the two in a partner's config. */
const CLIENT_ID_PREFIX = 'rbk_';

export function generateClientId(): string {
  return `${CLIENT_ID_PREFIX}${randomBytes(16).toString('hex')}`;
}

export function generateClientSecret(): string {
  // 32 bytes. The entropy is what makes the fast hash below the right choice,
  // so the two decisions have to stay tied together: if this ever shrinks, the
  // hash has to become a real KDF.
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * SHA-256, not bcrypt.
 *
 * The usual rule — never store a credential under a fast hash — exists because
 * humans pick passwords out of a space small enough to enumerate. A secret from
 * {@link generateClientSecret} has 256 bits of CSPRNG entropy; there is no
 * dictionary, no rainbow table, and no offline attack that a work factor would
 * slow down meaningfully. What a work factor WOULD do is add tens of
 * milliseconds to every token exchange, on the hot path of every login.
 *
 * This only holds while the secret stays machine-generated. If an admin is ever
 * allowed to type one in, this function has to change first.
 */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Last four characters, so an admin can tell two live secrets apart. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}

/**
 * Constant-time comparison of a presented secret against a stored hash.
 *
 * `===` on the hashes would leak, through timing, how many leading characters
 * an attacker got right — which turns a 256-bit secret into 64 sequential
 * one-character guesses. There is an existing `!==` comparison in
 * `payments/payment.webhook.controller.ts` that has exactly this shape; it is
 * not a model to copy.
 */
export function clientSecretMatches(
  presented: string,
  storedHash: string,
): boolean {
  const presentedHash = Buffer.from(hashClientSecret(presented), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal. Both sides are SHA-256 digests, so this can only differ if
  // the stored value is corrupt.
  if (presentedHash.length !== stored.length) return false;
  return timingSafeEqual(presentedHash, stored);
}

/**
 * The `sub` a given app sees for a given profile.
 *
 * Pairwise: two partners holding the same person's `sub` cannot tell it is the
 * same person, so integrating with Rabotka does not quietly enrol users into a
 * cross-site identity graph. The salt is what stops anyone who knows both ids
 * from recomputing it, so it is a secret and it is never rotated — rotating it
 * would silently orphan every user record every partner has ever created.
 */
export function derivePairwiseSub(
  appId: string,
  profileId: string,
  salt: string,
): string {
  return createHash('sha256')
    .update(`${appId}:${profileId}:${salt}`, 'utf8')
    .digest('base64url');
}
