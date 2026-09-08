import { Logger } from '@nestjs/common';
import { VovaAnonymousStore } from '../anonymous.store';

jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

const PHONE = '+242060000001';

function makeRedis(over: Record<string, unknown> = {}) {
  const exec = jest.fn().mockResolvedValue([]);
  const multi = {
    rpush: jest.fn(() => multi),
    ltrim: jest.fn(() => multi),
    expire: jest.fn(() => multi),
    exec,
  };
  return {
    lrange: jest.fn().mockResolvedValue([]),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    multi: jest.fn(() => multi),
    __multi: multi,
    ...over,
  };
}

/**
 * The store a stranger's conversation lives in.
 *
 * Its whole contract is "fail open": every method here sits directly in front
 * of a reply somebody is waiting for, and Redis being unavailable must cost a
 * repeated sentence or an unmetered call — never the answer.
 */
describe('VovaAnonymousStore', () => {
  describe('history()', () => {
    it('returns the stored turns in order', async () => {
      const redis = makeRedis({
        lrange: jest
          .fn()
          .mockResolvedValue([
            JSON.stringify({ role: 'user', text: 'c’est quoi Rabotka ?' }),
            JSON.stringify({ role: 'assistant', text: 'Une marketplace.' }),
          ]),
      });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.history(PHONE)).toEqual([
        { role: 'user', text: 'c’est quoi Rabotka ?' },
        { role: 'assistant', text: 'Une marketplace.' },
      ]);
    });

    it('drops a corrupted entry instead of failing the turn', async () => {
      const redis = makeRedis({
        lrange: jest
          .fn()
          .mockResolvedValue([
            'not json at all',
            JSON.stringify({ role: 'user', text: 'bonjour' }),
            JSON.stringify({ role: 'nonsense', text: 'x' }),
          ]),
      });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.history(PHONE)).toEqual([
        { role: 'user', text: 'bonjour' },
      ]);
    });

    it('returns nothing when Redis is down', async () => {
      const redis = makeRedis({
        lrange: jest.fn().mockRejectedValue(new Error('redis down')),
      });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.history(PHONE)).toEqual([]);
    });
  });

  describe('remember()', () => {
    it('writes the pair, trims and sets a TTL', async () => {
      const redis = makeRedis();
      const store = new VovaAnonymousStore(redis as never);

      await store.remember(PHONE, 'oui', 'Très bien.');

      // The question and its answer go in together: a dangling user turn makes
      // the model answer the same message twice.
      expect(redis.__multi.rpush).toHaveBeenCalledWith(
        expect.stringContaining(PHONE),
        JSON.stringify({ role: 'user', text: 'oui' }),
        JSON.stringify({ role: 'assistant', text: 'Très bien.' }),
      );
      expect(redis.__multi.ltrim).toHaveBeenCalled();
      expect(redis.__multi.expire).toHaveBeenCalled();
    });

    it('swallows a write failure', async () => {
      const redis = makeRedis({
        multi: jest.fn(() => {
          throw new Error('redis down');
        }),
      });
      const store = new VovaAnonymousStore(redis as never);

      await expect(store.remember(PHONE, 'a', 'b')).resolves.toBeUndefined();
    });
  });

  describe('consume()', () => {
    it('allows a reply while under the limit', async () => {
      const redis = makeRedis({ incr: jest.fn().mockResolvedValue(3) });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.consume(PHONE, 10)).toBe(true);
    });

    it('allows the reply that lands exactly on the limit', async () => {
      const redis = makeRedis({ incr: jest.fn().mockResolvedValue(10) });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.consume(PHONE, 10)).toBe(true);
    });

    it('refuses the one after it', async () => {
      const redis = makeRedis({ incr: jest.fn().mockResolvedValue(11) });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.consume(PHONE, 10)).toBe(false);
    });

    it('sets the expiry only on the first message of the day', async () => {
      const redis = makeRedis({ incr: jest.fn().mockResolvedValue(1) });
      const store = new VovaAnonymousStore(redis as never);
      await store.consume(PHONE, 10);
      expect(redis.expire).toHaveBeenCalled();

      const later = makeRedis({ incr: jest.fn().mockResolvedValue(2) });
      await new VovaAnonymousStore(later as never).consume(PHONE, 10);
      // Re-expiring on every message makes the window roll forward forever, so
      // a chatty number would never reset.
      expect(later.expire).not.toHaveBeenCalled();
    });

    it('refuses everything when the limit is zero', async () => {
      const redis = makeRedis();
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.consume(PHONE, 0)).toBe(false);
      expect(redis.incr).not.toHaveBeenCalled();
    });

    it('lets the reply through when Redis is down', async () => {
      // Being unable to count is not a reason to stop answering people.
      const redis = makeRedis({
        incr: jest.fn().mockRejectedValue(new Error('redis down')),
      });
      const store = new VovaAnonymousStore(redis as never);

      expect(await store.consume(PHONE, 10)).toBe(true);
    });
  });
});
