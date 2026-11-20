import { Injectable, Logger } from '@nestjs/common';
import { QueueService } from '../../services/queue/queue.service';
import type { DomainEvent, DomainEventType } from './domain-event.catalog';

/**
 * How relayed events reach a consumer. BullMQ today; a Kafka producer would
 * implement the same thing (one topic per aggregate, keyed by aggregate id) and
 * nothing else would change.
 *
 * Must be idempotent per (event, consumer): the relay sends at least once.
 */
export interface EventTransport {
  send(consumer: string, events: DomainEvent[]): Promise<void>;
}

/** One BullMQ queue per consumer: its own retries, failures and backlog. */
export function domainEventQueue(consumer: string): string {
  return `domain-events-${consumer}`;
}

/** BullMQ ignores an add whose jobId already exists: a re-send is a no-op. */
export function domainEventJobId(eventId: string, consumer: string): string {
  // BullMQ refuses a custom id containing ':'.
  return `${eventId}-${consumer}`;
}

@Injectable()
export class BullmqEventTransport implements EventTransport {
  constructor(private readonly queues: QueueService) {}

  async send(consumer: string, events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.queues.getQueue(domainEventQueue(consumer)).addBulk(
      events.map((event) => ({
        name: event.type,
        data: event,
        opts: { jobId: domainEventJobId(event.id, consumer) },
      })),
    );
  }
}

export type DomainEventSubscription<T extends DomainEventType> = {
  /** Stable name: the queue (and, with Kafka, the consumer group). */
  consumer: string;
  events: readonly T[];
  /**
   * Throw to have the event retried (3 attempts, exponential backoff); it then
   * stays in the consumer's failed jobs for a day. Must be idempotent.
   */
  handle: (event: DomainEvent<T>) => Promise<void>;
  concurrency?: number;
};

/**
 * Who listens to which domain event.
 *
 * Consumers subscribe in `onModuleInit`. The relay starts at application
 * bootstrap — after every `onModuleInit` — and seals the bus first, so no
 * event is ever relayed before all its consumers are known. A late
 * subscription throws rather than silently missing events.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly subscriptions = new Map<
    string,
    DomainEventSubscription<DomainEventType>
  >();
  private sealed = false;

  constructor(private readonly queues: QueueService) {}

  subscribe<T extends DomainEventType>(
    subscription: DomainEventSubscription<T>,
  ): void {
    if (this.sealed) {
      throw new Error(
        `Domain event consumer "${subscription.consumer}" subscribed after the relay started; subscribe in onModuleInit`,
      );
    }
    if (this.subscriptions.has(subscription.consumer)) {
      throw new Error(
        `Domain event consumer "${subscription.consumer}" subscribed twice`,
      );
    }
    this.subscriptions.set(subscription.consumer, subscription);
  }

  /** The consumers of one event type. */
  consumersOf(type: string): string[] {
    const consumers: string[] = [];
    for (const [consumer, sub] of this.subscriptions) {
      if ((sub.events as readonly string[]).includes(type)) {
        consumers.push(consumer);
      }
    }
    return consumers;
  }

  /** Seals the bus and starts one worker per consumer. Called by the relay. */
  start(): void {
    if (this.sealed) return;
    this.sealed = true;
    for (const sub of this.subscriptions.values()) {
      this.queues.createWorker<DomainEvent>(
        domainEventQueue(sub.consumer),
        (job) => sub.handle(job.data),
        { concurrency: sub.concurrency ?? 3 },
      );
      this.logger.log(
        `Consumer ${sub.consumer} listening to ${sub.events.join(', ')}`,
      );
    }
  }
}
