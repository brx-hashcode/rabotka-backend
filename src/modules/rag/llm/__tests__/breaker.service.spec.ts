import { Logger } from '@nestjs/common';
import { LlmBreakerService } from '../breaker.service';
import type { LlmProviderSpec } from '../llm.types';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const SPEC: LlmProviderSpec = { provider: 'google', model: 'gemini-2.0-flash' };

/** Minimal in-memory stand-in for the ioredis commands the breaker uses. */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    exists: jest.fn((key: string) => Promise.resolve(store.has(key) ? 1 : 0)),
    incr: jest.fn((key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return Promise.resolve(next);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    del: jest.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    set: jest.fn((key: string, value: string, ..._rest: unknown[]) => {
      if (store.has(key)) return Promise.resolve(null); // NX
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  };
}

function build(redis: ReturnType<typeof makeRedis>, threshold = 3) {
  const config = {
    get: jest.fn((key: string, fallback: number) =>
      key === 'VOVA_BREAKER_THRESHOLD' ? threshold : fallback,
    ),
  };
  return new LlmBreakerService(redis as never, config as never);
}

describe('LlmBreakerService', () => {
  it('starts closed', async () => {
    expect(await build(makeRedis()).isOpen(SPEC)).toBe(false);
  });

  it('opens after the configured number of consecutive failures', async () => {
    const redis = makeRedis();
    const breaker = build(redis, 3);

    expect(await breaker.recordFailure(SPEC)).toBe(false);
    expect(await breaker.recordFailure(SPEC)).toBe(false);
    expect(await breaker.isOpen(SPEC)).toBe(false);

    // The failure that opens it reports the transition, exactly once.
    expect(await breaker.recordFailure(SPEC)).toBe(true);
    expect(await breaker.isOpen(SPEC)).toBe(true);
    expect(await breaker.recordFailure(SPEC)).toBe(false);
  });

  it('counts consecutive failures — a success resets the streak', async () => {
    const redis = makeRedis();
    const breaker = build(redis, 3);

    await breaker.recordFailure(SPEC);
    await breaker.recordFailure(SPEC);
    await breaker.recordSuccess(SPEC);

    await breaker.recordFailure(SPEC);
    await breaker.recordFailure(SPEC);
    expect(await breaker.isOpen(SPEC)).toBe(false);
  });

  it('expires the failure counter so old failures cannot open a healthy provider', async () => {
    const redis = makeRedis();
    await build(redis).recordFailure(SPEC);
    expect(redis.expire).toHaveBeenCalledTimes(1); // only on the first failure
    await build(redis).recordFailure(SPEC);
    expect(redis.expire).toHaveBeenCalledTimes(1);
  });

  it('keys per provider AND model, so one model does not break its sibling', async () => {
    const redis = makeRedis();
    const breaker = build(redis, 1);
    await breaker.recordFailure(SPEC);

    expect(await breaker.isOpen(SPEC)).toBe(true);
    expect(
      await breaker.isOpen({
        provider: 'google',
        model: 'gemini-2.0-flash-lite',
      }),
    ).toBe(false);
  });

  // The breaker is an optimisation. Its own outage must degrade us to "no
  // breaker", never to "no assistant".
  it('fails open when Redis is down', async () => {
    const redis = makeRedis();
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    redis.exists.mockImplementation(down as never);
    redis.incr.mockImplementation(down as never);
    redis.del.mockImplementation(down as never);

    const breaker = build(redis);
    expect(await breaker.isOpen(SPEC)).toBe(false);
    expect(await breaker.recordFailure(SPEC)).toBe(false);
    await expect(breaker.recordSuccess(SPEC)).resolves.toBeUndefined();
  });
});
