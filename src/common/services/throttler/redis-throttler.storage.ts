import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';
import { REDIS_KEY_PREFIX } from '../redis/redis.constants';

/**
 * One hit, atomically: count it in the window, block the caller once the
 * limit is passed, and report where they stand.
 *
 * KEYS[1] = hit counter, KEYS[2] = block marker.
 * ARGV[1] = window (ms), ARGV[2] = limit, ARGV[3] = block duration (ms).
 * Returns { hits, windowLeftMs, blocked (0/1), blockLeftMs }.
 *
 * While blocked, hits are not counted. When the block starts, the counter is
 * given the block's lifetime, so both end together and the caller starts the
 * next window from zero — as the in-memory storage does.
 */
const HIT_SCRIPT = `
local blockLeft = redis.call('PTTL', KEYS[2])
if blockLeft > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockLeft}
end
local hits = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {hits, tonumber(ARGV[3]), 1, tonumber(ARGV[3])}
end
return {hits, left, 0, 0}
`;

const KEY_PREFIX = `${REDIS_KEY_PREFIX}throttle:`;

/** A positive whole number of milliseconds or hits, whatever form it came in. */
function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Rate-limit counters in Redis instead of process memory.
 *
 * The in-memory default kept a separate count per API instance (so N
 * instances allowed N times the limit) and forgot every count on restart.
 * Here every instance shares one counter per caller, and a block outlives a
 * deploy.
 *
 * Fails OPEN: if Redis cannot be reached the request is let through and a
 * warning logged. A rate limiter that turns a Redis blip into an outage of
 * every route does more harm than the abuse it guards against.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // Numbers whatever the caller passed: a string TTL is how the in-memory
    // storage ended up computing `Date.now() + "60000"` and blocking forever.
    const windowMs = positive(ttl, 60_000);
    const max = positive(limit, 100);
    const blockMs = positive(blockDuration, windowMs);
    const base = `${KEY_PREFIX}${throttlerName}:${key}`;

    try {
      const [hits, windowLeftMs, blocked, blockLeftMs] = (await this.redis.eval(
        HIT_SCRIPT,
        2,
        `${base}:hits`,
        `${base}:block`,
        windowMs,
        max,
        blockMs,
      )) as [number, number, number, number];

      return {
        totalHits: Number(hits),
        timeToExpire: Math.ceil(Number(windowLeftMs) / 1000),
        isBlocked: Number(blocked) === 1,
        timeToBlockExpire: Math.ceil(Number(blockLeftMs) / 1000),
      };
    } catch (err) {
      this.logger.warn(
        `Rate limit check skipped, Redis unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(windowMs / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
