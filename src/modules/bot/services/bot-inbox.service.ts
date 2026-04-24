import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const INBOX_KEY_PREFIX = 'bot:inbox:';
const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

export type InboxItem = {
  type: 'new_application';
  applicationId: string;
  workerName: string;
  offerTitle: string;
  createdAt: string;
};

@Injectable()
export class BotInboxService {
  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
  ) {}

  async push(profileId: string, item: InboxItem): Promise<void> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    await this.redis
      .pipeline()
      .rpush(key, JSON.stringify(item))
      .expire(key, INBOX_TTL_SECONDS)
      .exec();
  }

  async getAll(profileId: string): Promise<InboxItem[]> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raws = await this.redis.lrange(key, 0, -1);
    return raws.flatMap((r) => {
      try {
        return [JSON.parse(r) as InboxItem];
      } catch {
        return [];
      }
    });
  }

  async peek(profileId: string): Promise<InboxItem | null> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.lindex(key, 0);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InboxItem;
    } catch {
      return null;
    }
  }

  async shift(profileId: string): Promise<InboxItem | null> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.lpop(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InboxItem;
    } catch {
      return null;
    }
  }

  async count(profileId: string): Promise<number> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    return this.redis.llen(key);
  }
}
