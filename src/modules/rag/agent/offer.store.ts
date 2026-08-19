import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';

/**
 * Remembers the screen VoVa last offered, so « oui » means something.
 *
 * Short-lived on purpose: an offer accepted ten minutes later is almost
 * certainly a new conversation, and sending a card for a question the person
 * has forgotten asking is worse than sending nothing.
 *
 * Failures are swallowed. Losing an offer costs one extra exchange; letting a
 * Redis blip break the reply costs the conversation.
 */
@Injectable()
export class VovaOfferStore {
  private readonly logger = new Logger(VovaOfferStore.name);
  private readonly ttlSeconds = 600;

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  private key(profileId: string): string {
    return `${REDIS_KEY_PREFIX}vova:offer:${profileId}`;
  }

  async remember(profileId: string, destination: string): Promise<void> {
    try {
      await this.redis.set(
        this.key(profileId),
        destination,
        'EX',
        this.ttlSeconds,
      );
    } catch (err) {
      this.logger.debug(`Could not store the offer for ${profileId}`, err);
    }
  }

  /** Reads and clears — an offer is accepted once. */
  async take(profileId: string): Promise<string | null> {
    try {
      const key = this.key(profileId);
      const value = await this.redis.get(key);
      if (value) await this.redis.del(key);
      return value;
    } catch (err) {
      this.logger.debug(`Could not read the offer for ${profileId}`, err);
      return null;
    }
  }
}
