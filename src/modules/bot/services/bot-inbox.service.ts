import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';

const INBOX_KEY_PREFIX = `${REDIS_KEY_PREFIX}bot:inbox:`;
const INBOX_TTL_SECONDS = 7 * 24 * 60 * 60;

// Atomically reads the head item and removes it in a single round-trip.
// Returns nil if the list is empty, the raw JSON string otherwise.
const LUA_PEEK_AND_SHIFT = `
local val = redis.call('LINDEX', KEYS[1], 0)
if val == false then return false end
redis.call('LPOP', KEYS[1])
return val
`;

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

  async peekAndShift(profileId: string): Promise<InboxItem | null> {
    const key = `${INBOX_KEY_PREFIX}${profileId}`;
    const raw = (await this.redis.eval(LUA_PEEK_AND_SHIFT, 1, key)) as
      | string
      | null;
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
