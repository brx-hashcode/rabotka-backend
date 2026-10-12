import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

/**
 * Proof that whoever is signing up controls the phone number they gave.
 *
 * Signup used to take any number on trust: anyone could claim someone else's
 * number (locking its owner out of Rabotka) and make Rabotka send a WhatsApp
 * template to a stranger. Now the number is verified by a WhatsApp code first,
 * and that verification hands back this token. The KYC upload and the profile
 * creation both require it; creating the profile spends it.
 *
 * Stored by its SHA-256, never in clear: a Redis dump is not a set of live
 * tokens.
 */
export const SIGNUP_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * KYC files one verified signup may upload: front, back and a selfie, with
 * room to retake each a few times. Past this the upload is refused — the
 * route is unauthenticated, and each file can be 10 MB.
 */
export const SIGNUP_MAX_UPLOADS = 12;

const tokenKey = (token: string) =>
  `${REDIS_KEY_PREFIX}signup:token:${createHash('sha256').update(token).digest('hex')}`;
const uploadsKey = (token: string) => `${tokenKey(token)}:uploads`;

/** Issues a token for a phone number that has just been verified. */
export async function issueSignupToken(
  redis: Redis,
  phone: string,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(tokenKey(token), phone, 'EX', SIGNUP_TOKEN_TTL_SECONDS);
  return token;
}

/** The verified phone number the token stands for, or null. */
export async function phoneForSignupToken(
  redis: Redis,
  token: string | undefined | null,
): Promise<string | null> {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  return redis.get(tokenKey(token));
}

/**
 * Counts one KYC upload against the token. False once the token is unknown
 * or has used up its uploads.
 */
export async function countSignupUpload(
  redis: Redis,
  token: string | undefined | null,
): Promise<boolean> {
  if (!(await phoneForSignupToken(redis, token))) return false;
  const used = await redis.incr(uploadsKey(token as string));
  if (used === 1) {
    await redis.expire(uploadsKey(token as string), SIGNUP_TOKEN_TTL_SECONDS);
  }
  return used <= SIGNUP_MAX_UPLOADS;
}

/** Spends the token once the profile exists: it cannot create a second one. */
export async function consumeSignupToken(
  redis: Redis,
  token: string,
): Promise<void> {
  await redis.del(tokenKey(token), uploadsKey(token));
}
