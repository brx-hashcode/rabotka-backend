import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';

export { IdempotencyService } from '../../../../common/services/idempotency/idempotency.service';

/**
 * An in-memory Redis that implements SET NX honestly.
 *
 * The e2e is only worth running if the claim really is atomic-first-wins — a
 * mock that returns a canned value would pass whether or not the service ever
 * asks. This is the smallest thing that makes the assertion mean something.
 */
export const REDIS_CONNECTION_FOR_TESTS = {
  provide: REDIS_CONNECTION,
  useFactory: () => {
    const store = new Map<string, string>();
    return {
      set: (
        key: string,
        value: string,
        _ex?: string,
        _ttl?: number,
        nx?: string,
      ): Promise<string | null> => {
        if (nx === 'NX' && store.has(key)) return Promise.resolve(null);
        store.set(key, value);
        return Promise.resolve('OK');
      },
      del: (key: string): Promise<number> =>
        Promise.resolve(store.delete(key) ? 1 : 0),
      exists: (key: string): Promise<number> =>
        Promise.resolve(store.has(key) ? 1 : 0),
      // The ingest service rate-limits with an INCR/EXPIRE pipeline.
      pipeline: () => ({
        incr: function () {
          return this;
        },
        expire: function () {
          return this;
        },
        exec: () =>
          Promise.resolve([
            [null, 1],
            [null, 1],
          ]),
      }),
    };
  },
};
