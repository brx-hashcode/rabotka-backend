import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * PKCE, and only the S256 half of it.
 *
 * RFC 7636 also defines `plain`, where the challenge IS the verifier. That
 * defends against nothing — an attacker who intercepted the code from the
 * redirect also saw the challenge in the authorization request — and OAuth 2.1
 * removes it. Rabotka advertises `["S256"]` in its discovery document and
 * rejects anything else, including a missing method.
 */
export const SUPPORTED_CODE_CHALLENGE_METHODS = ['S256'] as const;

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Whether a `code_challenge` is well-formed enough to store.
 *
 * A challenge is a base64url-encoded SHA-256 digest, so it is always exactly 43
 * characters. Checking here means a partner who forgot to base64url-encode
 * (a common mistake — the raw hex is 64 characters) finds out at `authorize`,
 * before their user has typed anything, rather than at `token`.
 */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return (
    typeof challenge === 'string' && /^[A-Za-z0-9\-._~]{43}$/.test(challenge)
  );
}

/**
 * Whether the verifier presented at the token endpoint produced the challenge
 * that was stored with the code at the authorization endpoint.
 *
 * This is the entire point of PKCE: an attacker who steals the code out of the
 * redirect still cannot redeem it, because they never saw the verifier — it
 * never left the client that started the flow.
 */
export function verifyCodeChallenge(
  verifier: string,
  storedChallenge: string,
): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) {
    return false;
  }

  const computed = createHash('sha256').update(verifier, 'ascii').digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(storedChallenge, 'base64url');
  } catch {
    return false;
  }

  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}
