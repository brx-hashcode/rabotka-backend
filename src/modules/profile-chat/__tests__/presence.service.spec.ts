import { PresenceService } from '../presence.service';

/**
 * A stand-in for the bits of ioredis this uses, with real set semantics — the
 * point of the design is that membership is idempotent, and a mock that just
 * records calls could not show that.
 */
function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const of = (key: string) => sets.get(key) ?? sets.set(key, new Set()).get(key)!;

  const queued: (() => number)[] = [];
  const chain = {
    sadd: (key: string, id: string) => {
      of(key).add(id);
      return chain;
    },
    expire: () => chain,
    scard: (key: string) => {
      queued.push(() => sets.get(key)?.size ?? 0);
      return chain;
    },
    exec: () =>
      Promise.resolve(queued.splice(0).map((f) => [null, f()] as [null, number])),
  };

  return {
    sets,
    multi: () => chain,
    pipeline: () => chain,
    srem: (key: string, id: string) => {
      sets.get(key)?.delete(id);
      return Promise.resolve(1);
    },
  };
}

describe('PresenceService', () => {
  let redis: ReturnType<typeof fakeRedis>;
  let presence: PresenceService;

  beforeEach(() => {
    redis = fakeRedis();
    presence = new PresenceService(redis as never);
  });

  it('reports somebody online once a socket connects', async () => {
    await presence.connected('p-1', 's-1');
    expect(await presence.isOnline('p-1')).toBe(true);
  });

  it('keeps them online while a SECOND tab is still open', async () => {
    // The reason this is a set and not a boolean. Closing one of two tabs used
    // to read as leaving.
    await presence.connected('p-1', 's-1');
    await presence.connected('p-1', 's-2');

    await presence.disconnected('p-1', 's-1');
    expect(await presence.isOnline('p-1')).toBe(true);

    await presence.disconnected('p-1', 's-2');
    expect(await presence.isOnline('p-1')).toBe(false);
  });

  it('survives a disconnect that fires twice', async () => {
    // A counter would go negative here and never recover. Removing something
    // absent from a set is free.
    await presence.connected('p-1', 's-1');
    await presence.disconnected('p-1', 's-1');
    await presence.disconnected('p-1', 's-1');
    expect(await presence.isOnline('p-1')).toBe(false);
  });

  it('is idempotent on a repeated connect', async () => {
    await presence.connected('p-1', 's-1');
    await presence.connected('p-1', 's-1');
    await presence.disconnected('p-1', 's-1');
    expect(await presence.isOnline('p-1')).toBe(false);
  });

  it('answers for a whole list in one pipeline', async () => {
    await presence.connected('p-1', 's-1');
    await presence.connected('p-3', 's-3');

    const online = await presence.onlineAmong(['p-1', 'p-2', 'p-3']);
    expect([...online].sort()).toEqual(['p-1', 'p-3']);
  });

  it('returns nobody for an empty list, without touching Redis', async () => {
    const spy = jest.spyOn(redis, 'pipeline');
    expect((await presence.onlineAmong([])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  describe('when Redis is down', () => {
    beforeEach(() => {
      redis.pipeline = () => {
        throw new Error('connection refused');
      };
      redis.multi = () => {
        throw new Error('connection refused');
      };
      redis.srem = () => Promise.reject(new Error('connection refused'));
    });

    it('reads everybody as OFFLINE rather than throwing', async () => {
      // Fails closed on purpose. A missing green dot is a cosmetic loss;
      // claiming somebody is online makes the other party wait for a reply
      // that is not coming.
      await expect(presence.onlineAmong(['p-1'])).resolves.toEqual(new Set());
    });

    it('never lets a write failure reach the caller', async () => {
      // Presence is decoration. Redis being down must not stop somebody
      // connecting to their messages.
      await expect(presence.connected('p-1', 's-1')).resolves.toBeUndefined();
      await expect(
        presence.disconnected('p-1', 's-1'),
      ).resolves.toBeUndefined();
    });
  });
});
