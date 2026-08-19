import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import type { AnonymousTurn } from './agent.service';

/** Turns kept per stranger. Enough for a follow-up, not a transcript. */
const MAX_TURNS = 6;

/** How long an anonymous conversation stays warm. */
const TTL_SECONDS = 1800;

/**
 * Memory and spend limits for callers with no account, both keyed by phone.
 *
 * Redis rather than Postgres because there is no choice: `messages.profile_id`
 * is NOT NULL, so a stranger's words cannot be written to the transcript at
 * all. That is also why this is capped and short-lived — it is a conversation
 * buffer, not a record. The delivery log (`whatsapp_messages`, keyed on
 * `to_phone`) remains the durable trace of what was actually sent.
 *
 * **Everything here fails open.** A Redis outage must cost a repeated sentence
 * or an unmetered reply, never the reply itself — the person on the other end
 * asked a question and is waiting.
 */
@Injectable()
export class VovaAnonymousStore {
  private readonly logger = new Logger(VovaAnonymousStore.name);

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  private historyKey(phone: string): string {
    return `${REDIS_KEY_PREFIX}vova:anon:history:${phone}`;
  }

  private countKey(phone: string): string {
    return `${REDIS_KEY_PREFIX}vova:anon:count:${phone}`;
  }

  /** Recent turns, oldest first. Empty on a miss or on any failure. */
  async history(phone: string): Promise<AnonymousTurn[]> {
    try {
      const raw = await this.redis.lrange(this.historyKey(phone), 0, -1);
      return raw
        .map((entry) => this.parseTurn(entry))
        .filter((turn): turn is AnonymousTurn => turn !== null);
    } catch (err) {
      this.logger.debug(`Could not read anonymous history for ${phone}`, err);
      return [];
    }
  }

  /**
   * Append one exchange.
   *
   * The pair is written together so history can never hold a question with no
   * answer — a model reading a dangling user turn tends to answer it twice.
   */
  async remember(
    phone: string,
    userText: string,
    replyText: string,
  ): Promise<void> {
    try {
      const key = this.historyKey(phone);
      await this.redis
        .multi()
        .rpush(
          key,
          JSON.stringify({ role: 'user', text: userText }),
          JSON.stringify({ role: 'assistant', text: replyText }),
        )
        // Keep the last MAX_TURNS entries, dropping from the front.
        .ltrim(key, -MAX_TURNS, -1)
        .expire(key, TTL_SECONDS)
        .exec();
    } catch (err) {
      this.logger.debug(`Could not store anonymous history for ${phone}`, err);
    }
  }

  /**
   * Count this reply against the phone's daily allowance.
   *
   * Returns whether the caller is still within budget. Counted BEFORE the model
   * runs, so a provider that hangs still consumes its share — the limit exists
   * to bound spend by a stranger, and an expensive failed call is still
   * expensive.
   *
   * A Redis failure returns `true`. Being unable to count is not a reason to
   * stop answering people; it is a reason to look at Redis.
   */
  async consume(phone: string, dailyLimit: number): Promise<boolean> {
    if (dailyLimit <= 0) return false;

    try {
      const key = this.countKey(phone);
      const used = await this.redis.incr(key);
      // Only on the first increment, so the window is a fixed day from the
      // first message rather than a rolling one that never expires.
      if (used === 1) await this.redis.expire(key, secondsUntilMidnight());
      return used <= dailyLimit;
    } catch (err) {
      this.logger.debug(`Could not meter anonymous replies for ${phone}`, err);
      return true;
    }
  }

  private parseTurn(entry: string): AnonymousTurn | null {
    try {
      const parsed = JSON.parse(entry) as Partial<AnonymousTurn>;
      if (
        (parsed.role === 'user' || parsed.role === 'assistant') &&
        typeof parsed.text === 'string'
      ) {
        return { role: parsed.role, text: parsed.text };
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** UTC midnight. The market is UTC+1, so this resets an hour into the night. */
function secondsUntilMidnight(now = new Date()): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}
