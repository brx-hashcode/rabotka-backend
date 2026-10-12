import { RedisThrottlerStorage } from '../redis-throttler.storage';
import { positiveIntFromEnv } from '../positive-int-from-env';

describe('positiveIntFromEnv', () => {
  it('parses the string an environment variable holds', () => {
    expect(positiveIntFromEnv('60000', 1)).toBe(60_000);
  });

  it('keeps a number as it is', () => {
    expect(positiveIntFromEnv(100, 1)).toBe(100);
  });

  it.each([undefined, '', 'abc', '0', '-5'])('falls back on %p', (value) => {
    expect(positiveIntFromEnv(value, 42)).toBe(42);
  });
});

describe('RedisThrottlerStorage', () => {
  const evalWith = (reply: unknown) => ({
    eval: jest.fn().mockResolvedValue(reply),
  });

  it('reports the hits and the window left, in seconds', async () => {
    const redis = evalWith([3, 41_200, 0, 0]);
    const storage = new RedisThrottlerStorage(redis as never);

    await expect(
      storage.increment('k', 60_000, 100, 60_000, 'default'),
    ).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('reports a block and how long it has left', async () => {
    const redis = evalWith([101, 60_000, 1, 60_000]);
    const storage = new RedisThrottlerStorage(redis as never);

    const record = await storage.increment('k', 60_000, 100, 60_000, 'default');

    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(60);
  });

  it('sends numbers to Redis even when handed strings', async () => {
    // A string TTL is what made the in-memory storage block forever.
    const redis = evalWith([1, 60_000, 0, 0]);
    const storage = new RedisThrottlerStorage(redis as never);

    await storage.increment(
      'k',
      '60000' as never,
      '100' as never,
      '60000' as never,
      'default',
    );

    const [, keyCount, hitsKey, blockKey, windowMs, limit, blockMs] =
      redis.eval.mock.calls[0];
    expect(keyCount).toBe(2);
    expect(hitsKey).toMatch(/throttle:default:k:hits$/);
    expect(blockKey).toMatch(/throttle:default:k:block$/);
    expect([windowMs, limit, blockMs]).toEqual([60_000, 100, 60_000]);
  });

  it('blocks for the window when no block duration is given', async () => {
    const redis = evalWith([1, 30_000, 0, 0]);
    const storage = new RedisThrottlerStorage(redis as never);

    await storage.increment('k', 30_000, 10, 0, 'default');

    expect(redis.eval.mock.calls[0][6]).toBe(30_000);
  });

  it('lets the request through when Redis is unavailable', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    };
    const storage = new RedisThrottlerStorage(redis as never);

    await expect(
      storage.increment('k', 60_000, 100, 60_000, 'default'),
    ).resolves.toMatchObject({ isBlocked: false, totalHits: 0 });
  });
});
