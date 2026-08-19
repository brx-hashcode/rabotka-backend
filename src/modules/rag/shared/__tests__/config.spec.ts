import { Logger } from '@nestjs/common';
import { readNumber } from '../config';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const cfg = (values: Record<string, unknown>) => ({
  get: <T>(key: string) => values[key] as T,
});

describe('readNumber', () => {
  // The bug this exists for: an env var is a string, and `get<number>` does not
  // make it one. Qdrant answered a `limit: "5"` with a bare 400.
  it('coerces the string an environment variable actually is', () => {
    expect(readNumber(cfg({ X: '5' }) as never, 'X', 9)).toBe(5);
    expect(readNumber(cfg({ X: '0.2' }) as never, 'X', 9)).toBe(0.2);
    expect(readNumber(cfg({ X: ' 300000 ' }) as never, 'X', 9)).toBe(300000);
  });

  it('returns real numbers unchanged', () => {
    expect(readNumber(cfg({ X: 42 }) as never, 'X', 9)).toBe(42);
    expect(readNumber(cfg({ X: 0 }) as never, 'X', 9)).toBe(0);
  });

  it('falls back when the key is absent or blank', () => {
    expect(readNumber(cfg({}) as never, 'X', 9)).toBe(9);
    expect(readNumber(cfg({ X: '' }) as never, 'X', 9)).toBe(9);
    expect(readNumber(cfg({ X: null }) as never, 'X', 9)).toBe(9);
  });

  it('falls back loudly on a value that is not a number', () => {
    expect(readNumber(cfg({ X: 'beaucoup' }) as never, 'X', 9)).toBe(9);
    expect(readNumber(cfg({ X: NaN }) as never, 'X', 9)).toBe(9);
  });

  // The failure mode that would have been worst: a string TTL turns
  // `Date.now() + ttl` into concatenation, and the cache never expires.
  it('produces a value safe to add to a timestamp', () => {
    const ttl = readNumber(
      cfg({ VOVA_CATEGORY_TTL_MS: '300000' }) as never,
      'VOVA_CATEGORY_TTL_MS',
      1,
    );
    const expiry = Date.now() + ttl;
    expect(typeof expiry).toBe('number');
    expect(expiry - Date.now()).toBeLessThanOrEqual(300000);
  });
});
