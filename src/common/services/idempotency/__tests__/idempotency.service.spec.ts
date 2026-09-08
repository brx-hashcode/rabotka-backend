import {
  IdempotencyService,
  INBOUND_TTL_SECONDS,
  IN_FLIGHT_TTL_SECONDS,
  inFlightKey,
  OUTBOUND_TTL_SECONDS,
  hashParams,
  inboundKey,
  outboundKey,
} from '../idempotency.service';

/**
 * A Redis stand-in that actually implements SET NX, so the tests exercise the
 * semantics rather than a mock's return value. `expire()` is the only way to
 * simulate the passage of time — a real TTL cannot be waited out in a unit test.
 */
function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    expire: (key: string) => store.delete(key),
    set: jest.fn(
      (
        key: string,
        value: string,
        _ex: string,
        _ttl: number,
        nx?: string,
      ): Promise<string | null> => {
        if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve('OK');
      },
    ),
    del: jest.fn((key: string): Promise<number> => {
      const had = store.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),
    exists: jest.fn((key: string): Promise<number> =>
      Promise.resolve(store.has(key) ? 1 : 0),
    ),
  };
}

describe('IdempotencyService', () => {
  describe('claim()', () => {
    it('grants the first claim and refuses the second', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await expect(service.claim('k', 60)).resolves.toBe(true);
      await expect(service.claim('k', 60)).resolves.toBe(false);
    });

    it('passes the TTL through to Redis as SET … EX <ttl> NX', async () => {
      // The TTL is the whole fix: the duplicate that prompted this work arrived
      // 38 minutes after the original, against a 5-minute claim.
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await service.claim(inboundKey('wamid.1'), INBOUND_TTL_SECONDS);

      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('wa:in:done:wamid.1'),
        '1',
        'EX',
        604800,
        'NX',
      );
    });

    it('grants again once the key has expired', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await expect(service.claim('k', 1)).resolves.toBe(true);
      redis.expire('k'); // stands in for the TTL elapsing
      await expect(service.claim('k', 1)).resolves.toBe(true);
    });

    it('keeps separate keys independent', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await expect(service.claim('a', 60)).resolves.toBe(true);
      await expect(service.claim('b', 60)).resolves.toBe(true);
    });
  });

  describe('release()', () => {
    it('lets a released key be claimed again', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await service.claim('k', 60);
      await service.release('k');

      await expect(service.claim('k', 60)).resolves.toBe(true);
    });
  });

  describe('keys', () => {
    it('shares one namespace across providers', () => {
      // Twilio SIDs and Cloud wamids cannot collide, so one namespace keeps a
      // message de-duplicated across a provider flip.
      expect(inboundKey('SM1')).toContain('wa:in:done:SM1');
      expect(inboundKey('wamid.1')).toContain('wa:in:done:wamid.1');
    });

    it('separates outbound sends by recipient, template and params', () => {
      const a = outboundKey('+242069917686', 'otp', { code: '1' });
      expect(a).not.toBe(outboundKey('+242069917687', 'otp', { code: '1' }));
      expect(a).not.toBe(outboundKey('+242069917686', 'kyc', { code: '1' }));
      expect(a).not.toBe(outboundKey('+242069917686', 'otp', { code: '2' }));
    });

    it('uses the documented default window for outbound', () => {
      expect(OUTBOUND_TTL_SECONDS).toBe(60);
    });
  });

  describe('hashParams()', () => {
    it('is stable regardless of key order', () => {
      // JSON.stringify is insertion-ordered, so without sorting, two identical
      // messages built in different orders would hash differently and both go
      // out — exactly the duplicate the guard is meant to stop.
      expect(hashParams({ a: 1, b: 2 })).toBe(hashParams({ b: 2, a: 1 }));
    });

    it('is stable for nested objects', () => {
      expect(hashParams({ o: { a: 1, b: 2 } })).toBe(
        hashParams({ o: { b: 2, a: 1 } }),
      );
    });

    it('distinguishes different values', () => {
      expect(hashParams({ code: '123456' })).not.toBe(
        hashParams({ code: '654321' }),
      );
    });

    it('respects array order, which is meaningful', () => {
      expect(hashParams([1, 2])).not.toBe(hashParams([2, 1]));
    });

    it('handles primitives and null without throwing', () => {
      expect(hashParams(null)).toEqual(expect.any(String));
      expect(hashParams('x')).not.toBe(hashParams('y'));
    });
  });

  describe('has()', () => {
    it('answers without writing the key', async () => {
      // The reason this exists: asking with `claim` would SET the key as a side
      // effect of the question, and releasing it to undo that is racy — two
      // workers can both probe, both release, and both proceed.
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await expect(service.has('k')).resolves.toBe(false);
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.store.has('k')).toBe(false);
    });

    it('sees a key that was claimed', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);
      await service.claim('k', 60);
      await expect(service.has('k')).resolves.toBe(true);
    });
  });

  describe('the done marker and the in-flight lock are different keys', () => {
    it('does not collide for the same message', () => {
      // Collapsing these into one key is the bug being fixed: the lock has to
      // be released on failure, the marker has to survive for 7 days, and one
      // key cannot do both.
      expect(inboundKey('wamid.1')).not.toBe(inFlightKey('wamid.1'));
    });

    it('holding the lock does not mark the message handled', async () => {
      const redis = makeRedis();
      const service = new IdempotencyService(redis as never);

      await service.claim(inFlightKey('wamid.1'), IN_FLIGHT_TTL_SECONDS);

      await expect(service.has(inboundKey('wamid.1'))).resolves.toBe(false);
    });

    it('gives the lock a much shorter life than the marker', () => {
      // The lock is a backstop for a dead worker; the marker spans Meta's
      // retry window. Seven days of lock would strand a message.
      expect(IN_FLIGHT_TTL_SECONDS).toBeLessThan(INBOUND_TTL_SECONDS);
      expect(IN_FLIGHT_TTL_SECONDS).toBe(120);
    });
  });
});
