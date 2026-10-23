import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

/**
 * Proof that whoever is signing up controls the phone number — or, for a
 * business, the email address — they gave.
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

/**
 * What the token proves. `entry` is fixed when the code is verified: a code
 * received by email is a business sign-up, one received on WhatsApp is not,
 * and nothing sent later in a request body can change which.
 */
export type SignupIdentity =
  { entry: 'whatsapp'; phone: string } | { entry: 'business'; email: string };

const tokenKey = (token: string) =>
  `${REDIS_KEY_PREFIX}signup:token:${createHash('sha256').update(token).digest('hex')}`;
const uploadsKey = (token: string) => `${tokenKey(token)}:uploads`;

/** Issues a token for a phone number or email that has just been verified. */
export async function issueSignupToken(
  redis: Redis,
  identity: SignupIdentity,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(
    tokenKey(token),
    JSON.stringify(identity),
    'EX',
    SIGNUP_TOKEN_TTL_SECONDS,
  );
  return token;
}

/**
 * What the token stands for, or null. Tokens issued before the record existed
 * hold the bare phone number; they still read, as a WhatsApp sign-up, so a
 * sign-up in progress across the deploy is not broken.
 */
export async function readSignupToken(
  redis: Redis,
  token: string | undefined | null,
): Promise<SignupIdentity | null> {
  if (!token || typeof token !== 'string' || token.length > 128) return null;
  const stored = await redis.get(tokenKey(token));
  if (!stored) return null;
  if (!stored.startsWith('{')) return { entry: 'whatsapp', phone: stored };
  try {
    const parsed = JSON.parse(stored) as Partial<{
      entry: string;
      phone: string;
      email: string;
    }>;
    if (parsed.entry === 'business' && typeof parsed.email === 'string') {
      return { entry: 'business', email: parsed.email };
    }
    if (parsed.entry === 'whatsapp' && typeof parsed.phone === 'string') {
      return { entry: 'whatsapp', phone: parsed.phone };
    }
  } catch {
    // Not ours: unreadable is unknown.
  }
  return null;
}

/**
 * Counts one KYC upload against the token. False once the token is unknown
 * or has used up its uploads.
 */
export async function countSignupUpload(
  redis: Redis,
  token: string | undefined | null,
): Promise<boolean> {
  if (!(await readSignupToken(redis, token))) return false;
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
