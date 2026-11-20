import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  BullmqEventTransport,
  DomainEventBus,
} from './domain-event-bus.service';
import {
  DomainEventRelay,
  EVENT_TRANSPORT,
} from './domain-event-relay.service';

/**
 * Durable domain events: a transactional outbox (`domain_events`), relayed to
 * one BullMQ queue per consumer. API process only — the worker process does
 * not import it.
 *
 * Producers call `publishDomainEvent(tx, …)` (no injection needed); consumers
 * inject DomainEventBus and `subscribe` in `onModuleInit`.
 *
 * To move to Kafka: bind EVENT_TRANSPORT to a Kafka producer and turn the
 * bus's workers into consumer groups of the same names.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    DomainEventBus,
    DomainEventRelay,
    BullmqEventTransport,
    { provide: EVENT_TRANSPORT, useExisting: BullmqEventTransport },
  ],
  exports: [DomainEventBus],
})
export class DomainEventsModule {}
