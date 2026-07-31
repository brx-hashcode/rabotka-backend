import { Logger } from '@nestjs/common';
import {
  AdminCacheService,
  hashFilters,
  ADMIN_LIST_TTL_SECONDS,
} from '../admin-cache.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    scan: jest.fn().mockResolvedValue(['0', []]),
    del: jest.fn().mockResolvedValue(1),
  };
}

describe('AdminCacheService', () => {
  let service: AdminCacheService;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    redis = makeRedis();
    service = new AdminCacheService(redis as never);
  });

  describe('wrap()', () => {
    it('runs the loader and caches the result on a miss', async () => {
      const loader = jest.fn().mockResolvedValue({ items: [1] });

      const out = await service.wrap('k', ADMIN_LIST_TTL_SECONDS, loader);

      expect(out).toEqual({ items: [1] });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(redis.set).toHaveBeenCalledWith(
        'k',
        JSON.stringify({ items: [1] }),
        'EX',
        ADMIN_LIST_TTL_SECONDS,
      );
    });

    it('returns the cached value without touching the loader on a hit', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ items: [2] }));
      const loader = jest.fn();

      expect(await service.wrap('k', 60, loader)).toEqual({ items: [2] });
      expect(loader).not.toHaveBeenCalled();
    });

    it('returns live data when the cache READ throws', async () => {
      // Fails open: a Redis outage must not take the admin panel down.
      redis.get.mockRejectedValue(new Error('redis down'));
      const loader = jest.fn().mockResolvedValue({ items: [3] });

      expect(await service.wrap('k', 60, loader)).toEqual({ items: [3] });
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('still returns data when the cache WRITE throws', async () => {
      redis.set.mockRejectedValue(new Error('redis full'));
      const loader = jest.fn().mockResolvedValue({ items: [4] });

      expect(await service.wrap('k', 60, loader)).toEqual({ items: [4] });
    });

    it('propagates a loader failure rather than masking it', async () => {
      const loader = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(service.wrap('k', 60, loader)).rejects.toThrow('db down');
    });
  });

  describe('key derivation', () => {
    it('gives different filters different keys', () => {
      // This is what makes a filter change correct by construction — a new
      // filter simply cannot hit the previous filter's entry.
      const a = service.listKey('profiles', { status: 'ACTIVE', page: 1 });
      const b = service.listKey('profiles', { status: 'SUSPENDED', page: 1 });
      expect(a).not.toBe(b);
    });

    it('gives different pages different keys', () => {
      expect(service.listKey('profiles', { page: 1 })).not.toBe(
        service.listKey('profiles', { page: 2 }),
      );
    });

    it('is stable regardless of key order', () => {
      expect(hashFilters({ a: 1, b: 2 })).toBe(hashFilters({ b: 2, a: 1 }));
    });

    it('ignores undefined values', () => {
      // Otherwise an unset optional filter would miss the cache every time.
      expect(hashFilters({ a: 1 })).toBe(hashFilters({ a: 1, b: undefined }));
    });

    it('does not confuse two entities', () => {
      expect(service.listKey('profiles', { page: 1 })).not.toBe(
        service.listKey('jobs', { page: 1 }),
      );
    });

    it('separates list keys from dashboard keys', () => {
      expect(service.listKey('profiles', {})).not.toBe(
        service.dashboardKey('profiles', {}),
      );
    });
  });

  describe('invalidate()', () => {
    it('scans and deletes both the entity lists and the dashboard', async () => {
      redis.scan
        .mockResolvedValueOnce(['0', ['k1', 'k2']])
        .mockResolvedValueOnce(['0', ['d1']]);

      await service.invalidate('profiles');

      expect(redis.del).toHaveBeenCalledWith('k1', 'k2');
      expect(redis.del).toHaveBeenCalledWith('d1');
    });

    it('uses SCAN, never KEYS', async () => {
      // KEYS blocks the whole Redis instance, which on a shared instance
      // stalls the queue and the websocket gateway too.
      await service.invalidate('profiles');
      expect(redis.scan).toHaveBeenCalled();
      expect((redis as Record<string, unknown>).keys).toBeUndefined();
    });

    it('follows the cursor until it wraps to 0', async () => {
      redis.scan
        .mockResolvedValueOnce(['17', ['a']])
        .mockResolvedValueOnce(['0', ['b']])
        .mockResolvedValueOnce(['0', []]);

      await service.invalidate('profiles');

      expect(redis.del).toHaveBeenCalledWith('a');
      expect(redis.del).toHaveBeenCalledWith('b');
    });

    it('does not throw when Redis is unavailable', async () => {
      redis.scan.mockRejectedValue(new Error('redis down'));
      await expect(service.invalidate('profiles')).resolves.toBeUndefined();
    });

    it('skips DEL when a pass matched nothing', async () => {
      redis.scan.mockResolvedValue(['0', []]);
      await service.invalidate('profiles');
      expect(redis.del).not.toHaveBeenCalled();
    });
  });
});
