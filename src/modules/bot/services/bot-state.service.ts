import { Injectable, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { BOT_STATE_KEY_PREFIX, BOT_STATE_TTL_SECONDS } from '../bot.constants';
import type { BotState } from '../types/bot-state.types';

// CAS write: only sets the value if the key is absent OR the current flowId matches expectedFlowId.
// Returns 1 on write, 0 if blocked by an active different flow.
const LUA_CAS_SET = `
local current = redis.call('GET', KEYS[1])
if current == false then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
local ok, parsed = pcall(cjson.decode, current)
if not ok or parsed.flowId == ARGV[3] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`;

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

  /**
   * Unconditional write — used by the webhook handler which holds the per-user lock.
   * Safe to call without CAS because the lock prevents concurrent webhook writes.
   */
  async set(profileId: string, state: BotState): Promise<void> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
    await this.redis.set(key, value, 'EX', BOT_STATE_TTL_SECONDS);
  }

  /**
   * CAS write — used by notification services writing outside the webhook lock.
   * Only writes if no active flow exists or the current flowId matches expectedFlowId.
   * Returns true if the write succeeded.
   */
  async setIfFlowAbsentOrMatches(
    profileId: string,
    state: BotState,
    expectedFlowId: string | null,
  ): Promise<boolean> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    const value = JSON.stringify({ ...state, updatedAt: new Date().toISOString() });
    const result = await this.redis.eval(
      LUA_CAS_SET,
      1,
      key,
      value,
      String(BOT_STATE_TTL_SECONDS),
      expectedFlowId ?? '',
    );
    return result === 1;
  }

  async clear(profileId: string): Promise<void> {
    const key = `${BOT_STATE_KEY_PREFIX}${profileId}`;
    await this.redis.del(key);
  }
}
