import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

const logger = new Logger('VovaConfig');

/**
 * Reads a numeric setting, as a number.
 *
 * `ConfigService.get<number>('X', 5)` does **not** return a number. Without a
 * validation schema that casts it, an environment variable is a string all the
 * way through, and the `<number>` type parameter is a claim TypeScript accepts
 * without checking. The fallback is only returned when the key is absent, so
 * the bug hides completely until someone sets the variable — at which point:
 *
 * - `Date.now() + ttl` becomes string concatenation, and a cache TTL of five
 *   minutes turns into a timestamp ~50 000 years from now, so nothing ever
 *   refreshes;
 * - a `limit` handed to Qdrant as `"5"` is rejected with a bare 400, which
 *   surfaces as "retrieval is broken" with no clue why.
 *
 * Both of those happened here. This helper is the reason they cannot happen
 * again, and every numeric read in the module goes through it.
 */
export function readNumber(
  config: Pick<ConfigService, 'get'>,
  key: string,
  fallback: number,
): number {
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;

  if (typeof raw !== 'number' && typeof raw !== 'string') {
    logger.warn(`${key} is neither a number nor a string — using ${fallback}`);
    return fallback;
  }

  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    logger.warn(
      `${key}="${raw}" is not a number — falling back to ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}
