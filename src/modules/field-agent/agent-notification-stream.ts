import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const CHANNEL = `${REDIS_KEY_PREFIX}agent-notifications`;

type Envelope = { agentId: string; notification: unknown };

/**
 * Fans a new notification out to the agent's open streams on every API
 * instance: `publish` goes through Redis, and each instance's subscriber
 * hands it to the streams it holds for that agent.
 *
 * The agent app reaches the backend through its own same-origin proxy with a
 * bearer token taken from an httpOnly cookie, so a server-sent event stream
 * through that proxy is the live channel — a socket would need the token in
 * JavaScript or a cross-site cookie.
 */
@Injectable()
export class AgentNotificationStream implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentNotificationStream.name);
  private readonly listeners = new Map<string, Set<Subject<unknown>>>();
  private subscriber: Redis | null = null;

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL) return;
      try {
        const { agentId, notification } = JSON.parse(raw) as Envelope;
        this.listeners.get(agentId)?.forEach((s) => s.next(notification));
      } catch {
        // A malformed message is someone else's bug; drop it.
      }
    });
    try {
      await this.subscriber.subscribe(CHANNEL);
    } catch (err) {
      // Streams then only see what this instance publishes; the bell still
      // catches up on its next fetch.
      this.logger.error('Could not subscribe to agent notifications', err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.forEach((set) => set.forEach((s) => s.complete()));
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** Best-effort: a lost publish only delays the agent until their next fetch. */
  async publish(agentId: string, notification: unknown): Promise<void> {
    try {
      await this.redis.publish(
        CHANNEL,
        JSON.stringify({ agentId, notification } satisfies Envelope),
      );
    } catch (err) {
      this.logger.warn(`Live push to agent ${agentId} failed: ${String(err)}`);
    }
  }

  /** The agent's notifications as they are published, until unsubscribed. */
  forAgent(agentId: string): Observable<unknown> {
    return new Observable((observer) => {
      const subject = new Subject<unknown>();
      const subscription = subject.subscribe(observer);
      const set = this.listeners.get(agentId) ?? new Set();
      set.add(subject);
      this.listeners.set(agentId, set);
      return () => {
        subscription.unsubscribe();
        set.delete(subject);
        if (set.size === 0) this.listeners.delete(agentId);
      };
    });
  }
}
