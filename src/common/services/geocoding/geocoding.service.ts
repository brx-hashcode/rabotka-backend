import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION, REDIS_KEY_PREFIX } from '../redis/redis.constants';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout.util';

export type Coordinates = { lat: number; lng: number };

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — addresses don't move
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Rabotka/1.0 (blondeau.nbif@mail.com)';
const TIMEOUT_MS = 8_000;
const MAX_RETRIES = 3;
const CITY_HINT = 'Brazzaville Congo';

function cacheKey(address: string): string {
  const normalized = address.toLowerCase().trim();
  return `${REDIS_KEY_PREFIX}geocode:${normalized}`;
}

// Append city hint when the address doesn't already reference Brazzaville,
// so Nominatim can locate it without lat/lng bias.
function enrichQuery(address: string): string {
  const lower = address.toLowerCase();
  if (lower.includes('brazzaville') || lower.includes('congo')) return address;
  return `${address.trim()}, ${CITY_HINT}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async geocode(address: string): Promise<Coordinates | null> {
    const key = cacheKey(address);

    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as Coordinates;
      } catch {
        // stale / corrupt entry — fall through to re-fetch
      }
    }

    const query = enrichQuery(address);
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    const urlStr = url.toString();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetchWithTimeout(
          urlStr,
          { headers: { 'User-Agent': USER_AGENT } },
          TIMEOUT_MS,
        );

        if (!response.ok) {
          this.logger.warn(
            `Nominatim returned ${response.status} for "${address}" (attempt ${attempt})`,
          );
          break; // HTTP error — retrying won't help
        }

        const results = (await response.json()) as Array<{
          lat: string;
          lon: string;
        }>;

        if (!results.length) {
          this.logger.debug(`No geocode result for "${address}"`);
          return null;
        }

        const coords: Coordinates = {
          lat: parseFloat(results[0].lat),
          lng: parseFloat(results[0].lon),
        };

        await this.redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(coords));
        return coords;
      } catch (err) {
        const isLastAttempt = attempt === MAX_RETRIES;
        if (isLastAttempt) {
          this.logger.warn(
            `Geocoding failed for "${address}" after ${MAX_RETRIES} attempts`,
            err,
          );
        } else {
          // Exponential backoff: 1s, 2s before retrying
          await sleep(1_000 * attempt);
        }
      }
    }

    return null;
  }
}
