import { HttpException, HttpStatus } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type Redis from 'ioredis';

/**
 * The one-time-code primitives every login flow shares: profiles, admins and
 * field agents.
 *
 * Extracted from AuthService when agents got their own login, so the attempt
 * limit, the send cap and the atomic check-and-delete exist once. A second
 * copy is a second place for a limit to be forgotten.
 */

export const OTP_TTL_SECONDS = 300;

/**
 * How many wrong guesses one code survives.
 *
 * There was no limit at all: a 6-digit code lives five minutes, and nothing but
 * the global per-IP throttle stood between it and a client simply trying them.
 * After this many misses the code is destroyed, so the guesser has to request
 * another — and requests are capped per identifier below.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * How many codes one identifier may be sent per window.
 *
 * The other half of the attempt limit: without it a guesser resets their five
 * tries by asking for a fresh code. It also bounds what an anonymous caller can
 * spend on somebody else's number — every WhatsApp code is a paid template.
 */
export const OTP_MAX_SENDS = 5;
export const OTP_SEND_WINDOW_SECONDS = 15 * 60;

/**
 * KEYS[1] the code, KEYS[2] its miss counter.
 * ARGV[1] the guess, ARGV[2] the miss limit, ARGV[3] the counter's TTL.
 *
 * Returns 1 on a match (code and counter deleted), 0 on a miss or when there is
 * no code. The miss that reaches the limit deletes the code too, so every later
 * guess — the right one included — finds nothing.
 *
 * One script rather than a GET and an INCR: two round trips would let parallel
 * guesses all read the counter before any of them wrote it.
 */
const LUA_VERIFY_AND_DELETE_OTP = `
local v = redis.call('GET', KEYS[1])
if v == false then return 0 end
if v == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 1
end
local misses = redis.call('INCR', KEYS[2])
if misses == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
if misses >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return 0
`;

export function generateOtp(): string {
  return randomInt(100000, 1000000).toString();
}

/** Stores a fresh code and resets its miss counter. */
export async function storeOtp(
  redis: Pick<Redis, 'set' | 'del'>,
  otpKey: string,
  attemptsKey: string,
  otp: string,
): Promise<void> {
  await redis.set(otpKey, otp, 'EX', OTP_TTL_SECONDS);
  await redis.del(attemptsKey);
}

/** True when `otp` matches; the code is consumed either way it ends. */
export async function consumeOtp(
  redis: Pick<Redis, 'eval'>,
  otpKey: string,
  attemptsKey: string,
  otp: string,
): Promise<boolean> {
  const matched = await redis.eval(
    LUA_VERIFY_AND_DELETE_OTP,
    2,
    otpKey,
    attemptsKey,
    otp,
    OTP_MAX_ATTEMPTS,
    OTP_TTL_SECONDS,
  );
  return matched === 1;
}

/** Counts a send against `key` and throws 429 past the per-window cap. */
export async function assertCanSendOtp(
  redis: Pick<Redis, 'incr' | 'expire'>,
  key: string,
): Promise<void> {
  const sends = await redis.incr(key);
  if (sends === 1) {
    await redis.expire(key, OTP_SEND_WINDOW_SECONDS);
  }
  if (sends > OTP_MAX_SENDS) {
    throw new HttpException(
      'Trop de codes demandés. Veuillez réessayer dans quelques minutes.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
