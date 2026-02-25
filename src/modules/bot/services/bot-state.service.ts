import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { BOT_STATE_KEY_PREFIX, BOT_STATE_TTL_SECONDS } from '../bot.constants';
import type { BotState } from '../types/bot-state.types';

@Injectable()
export class BotStateService {
  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
  ) {}

  async get(profileId: string): Promise<BotState | null> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as BotState;
      return state?.flowId ? state : null;
    } catch {
      return null;
    }
  }

  async set(profileId: string, state: BotState): Promise<void> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    const value = JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    await this.redis.set(key, value, 'EX', BOT_STATE_TTL_SECONDS);
  }

  async clear(profileId: string): Promise<void> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    await this.redis.del(key);
  }
}
