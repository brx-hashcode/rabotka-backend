import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION, REDIS_KEY_PREFIX } from '../redis/redis.constants';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout.util';

export type Coordinates = { lat: number; lng: number };

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — addresses don't move
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Rabotka/1.0 (anthonymedin963@gmail.com)';

function cacheKey(address: string): string {
  const normalized = address.toLowerCase().trim();
  return `${REDIS_KEY_PREFIX}geocode:${normalized}`;
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

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

    try {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set('q', address);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '1');

      const response = await fetchWithTimeout(
        url.toString(),
        { headers: { 'User-Agent': USER_AGENT } },
        5_000,
      );

      if (!response.ok) {
        this.logger.warn(`Nominatim returned ${response.status} for "${address}"`);
        return null;
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
      this.logger.warn(`Geocoding failed for "${address}"`, err);
      return null;
    }
  }
}
