import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../redis/redis.constants';

/** Admin list responses change often but are read constantly. */
export const ADMIN_LIST_TTL_SECONDS = 60;
/** Dashboard aggregates are the expensive queries and tolerate more lag. */
export const ADMIN_DASHBOARD_TTL_SECONDS = 120;

/** How many keys a single SCAN pass asks for. */
const SCAN_COUNT = 200;

/**
 * Read-through cache for admin list and dashboard reads.
 *
 * Two properties matter more than hit rate:
 *
 * 1. **It fails open.** Every Redis call is wrapped; on any error the loader
 *    runs and live data is returned. A cache outage must never take the admin
 *    panel down — it is a latency optimisation, not a dependency.
 * 2. **Filters are part of the key.** The key hashes the whole normalised
 *    filter/page/sort object, so changing a filter cannot return the previous
 *    filter's rows. Correct by construction rather than by remembering to
 *    invalidate.
 */
@Injectable()
export class AdminCacheService {
  private readonly logger = new Logger(AdminCacheService.name);

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  /** `admin:list:<entity>:<hash>` — stable across key order and undefined values. */
  listKey(entity: string, filters: unknown): string {
    return `${REDIS_KEY_PREFIX}admin:list:${entity}:${hashFilters(filters)}`;
  }

  dashboardKey(scope: string, filters: unknown = {}): string {
    return `${REDIS_KEY_PREFIX}admin:dashboard:${scope}:${hashFilters(filters)}`;
  }

  /**
   * Returns the cached value for `key`, or runs `loader`, caches it and returns
   * that. Never throws on a cache fault.
   */
  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch (err) {
      this.logger.warn(`Cache read failed for ${key}`, err);
      return loader();
    }

    const value = await loader();
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Cache write failed for ${key}`, err);
    }
    return value;
  }

  /**
   * Drops every cached list for an entity plus all dashboard aggregates,
   * because any write can move a dashboard count.
   *
   * Uses SCAN, never KEYS: `KEYS` blocks the whole Redis instance for the
   * duration of the match, which on a shared instance stalls the queue and the
   * websocket gateway too.
   */
  async invalidate(entity: string): Promise<void> {
    await Promise.all([
      this.deleteByPattern(`${REDIS_KEY_PREFIX}admin:list:${entity}:*`),
      this.deleteByPattern(`${REDIS_KEY_PREFIX}admin:dashboard:*`),
    ]);
  }

  private async deleteByPattern(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          SCAN_COUNT,
        );
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      // A failed invalidation means stale reads until the TTL expires — bad,
      // but not worth failing the write the admin actually asked for.
      this.logger.warn(`Cache invalidation failed for ${pattern}`, err);
    }
  }
}

/**
 * Stable hash of a filter object.
 *
 * Keys are sorted and `undefined` is dropped, so `{a:1,b:2}` and `{b:2,a:1}`
 * and `{a:1,b:2,c:undefined}` all collapse to one key — otherwise equivalent
 * requests would each miss the cache.
 */
export function hashFilters(filters: unknown): string {
  return createHash('sha1').update(stableStringify(filters)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
