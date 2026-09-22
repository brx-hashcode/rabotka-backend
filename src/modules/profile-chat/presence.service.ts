import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const KEY = (profileId: string) => `${REDIS_KEY_PREFIX}presence:${profileId}`;

/**
 * How long a presence entry survives without being refreshed.
 *
 * Purely a backstop for an instance that dies without running its disconnect
 * handlers. Normal departures are removed immediately, so this only decides how
 * long a crash leaves somebody looking online.
 */
const TTL_SECONDS = 90;

/**
 * Who is currently connected, across every API instance.
 *
 * IN REDIS, NOT IN A MAP, and that is the whole reason this file exists. The
 * admin chat next door keeps presence in a per-process `Map`
 * (`chat.gateway.ts`), which is correct only while exactly one instance runs —
 * and the Socket.IO Redis adapter is installed globally in `main.ts`, which
 * says plainly that more than one is expected. With two instances a local map
 * reports "offline" for everybody connected to the other one.
 *
 * A SET of socket ids rather than a counter, because a counter drifts: a
 * disconnect that fires twice, or one that never fires at all, leaves it
 * permanently wrong with no way to notice. Set membership is idempotent —
 * removing something that is not there is free — so the worst a lost event
 * costs is one stale entry, and the TTL collects that.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async connected(profileId: string, socketId: string): Promise<void> {
    try {
      await this.redis
        .multi()
        .sadd(KEY(profileId), socketId)
        .expire(KEY(profileId), TTL_SECONDS)
        .exec();
    } catch (error) {
      // Presence is decoration. Redis being down must not stop somebody
      // reading their messages.
      this.logger.warn(`presence add failed: ${(error as Error).message}`);
    }
  }

  async disconnected(profileId: string, socketId: string): Promise<void> {
    try {
      await this.redis.srem(KEY(profileId), socketId);
    } catch (error) {
      this.logger.warn(`presence remove failed: ${(error as Error).message}`);
    }
  }

  /** Pushes the TTL out for sockets still held by this instance. */
  async refresh(profileIds: readonly string[]): Promise<void> {
    if (profileIds.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const id of profileIds) pipeline.expire(KEY(id), TTL_SECONDS);
      await pipeline.exec();
    } catch {
      // Next tick will try again; a missed refresh costs at most one TTL.
    }
  }

  /**
   * Which of these profiles are online.
   *
   * One pipeline for the whole batch — a conversation list would otherwise be
   * one round trip per row, which is the shape that makes people give up on
   * presence entirely.
   *
   * FAILS CLOSED: on any error everybody reads as offline. Wrongly showing
   * someone offline is a missing green dot; wrongly showing them online means
   * the other party waits for a reply that is not coming.
   */
  async onlineAmong(profileIds: readonly string[]): Promise<Set<string>> {
    if (profileIds.length === 0) return new Set();
    try {
      const pipeline = this.redis.pipeline();
      for (const id of profileIds) pipeline.scard(KEY(id));
      const results = await pipeline.exec();

      const online = new Set<string>();
      results?.forEach(([error, value], index) => {
        if (!error && typeof value === 'number' && value > 0) {
          online.add(profileIds[index]);
        }
      });
      return online;
    } catch (error) {
      this.logger.warn(`presence read failed: ${(error as Error).message}`);
      return new Set();
    }
  }

  async isOnline(profileId: string): Promise<boolean> {
    return (await this.onlineAmong([profileId])).has(profileId);
  }
}
