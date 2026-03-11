import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const INBOX_KEY_PREFIX = 'bot:inbox:';
const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

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
    const raw = await this.redis.get(key);
    const items: InboxItem[] = raw ? (JSON.parse(raw) as InboxItem[]) : [];
    items.push(item);
    await this.redis.set(key, JSON.stringify(items), 'EX', INBOX_TTL_SECONDS);
  }

  async getAll(profileId: string): Promise<InboxItem[]> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.get(key);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as InboxItem[];
    } catch {
      return [];
    }
  }

  /** Remove and return the oldest item from the inbox. */
  async shift(profileId: string): Promise<InboxItem | null> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    let items: InboxItem[];
    try {
      items = JSON.parse(raw) as InboxItem[];
    } catch {
      return null;
    }
    if (items.length === 0) return null;
    const first = items.shift()!;
    if (items.length === 0) {
      await this.redis.del(key);
    } else {
      await this.redis.set(key, JSON.stringify(items), 'EX', INBOX_TTL_SECONDS);
    }
    return first;
  }

  async count(profileId: string): Promise<number> {
    const items = await this.getAll(profileId);
    return items.length;
  }
}
