import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';

const DRAFT_KEY_PREFIX = `${REDIS_KEY_PREFIX}bot:draft:publish:`;
const DRAFT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export type PublishJobDraft = {
  step: number;
  payload: Record<string, unknown>;
  savedAt: string;
};

@Injectable()
export class BotDraftService {
  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
  ) {}

  async saveDraft(profileId: string, draft: PublishJobDraft): Promise<void> {
    const key = `${DRAFT_KEY_PREFIX}${profileId}`;
    await this.redis.set(key, JSON.stringify(draft), 'EX', DRAFT_TTL_SECONDS);
  }

  async getDraft(profileId: string): Promise<PublishJobDraft | null> {
    const key = `${DRAFT_KEY_PREFIX}${profileId}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PublishJobDraft;
    } catch {
      return null;
    }
  }

  async clearDraft(profileId: string): Promise<void> {
    const key = `${DRAFT_KEY_PREFIX}${profileId}`;
    await this.redis.del(key);
  }
}
