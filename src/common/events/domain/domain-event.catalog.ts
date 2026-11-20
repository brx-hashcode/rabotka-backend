import type { PaymentRequestType } from '@prisma/client';

/**
 * Every domain event, by type, with its payload.
 *
 * A domain event is a fact the business cares about that something else must
 * act on reliably: it is written in the transaction of the change it describes
 * (publishDomainEvent) and delivered at least once to every consumer that
 * subscribed to it (DomainEventBus). Live-UI signals — a socket to close, a
 * progress bar — stay on EventEmitter2: losing one of those is harmless.
 *
 * Changing a payload: add fields freely; to remove or retype one, bump the
 * event's version and have consumers read both while rows of the old version
 * may still be pending or replayed (30 days).
 */
export interface DomainEventCatalog {
  /** A payment request was paid and claimed (persistApprovedPayment), once. */
  'payment.approved': {
    paymentRequestId: string;
    /** `payment_requests.request_type`, nullable in the schema. */
    requestType: PaymentRequestType | null;
    profileId: string;
  };
}

export type DomainEventType = keyof DomainEventCatalog;

/** What each event is about: the future Kafka topic. */
export const DOMAIN_EVENT_AGGREGATES: Record<DomainEventType, string> = {
  'payment.approved': 'payment_request',
};

/** An event as a consumer receives it. */
export type DomainEvent<T extends DomainEventType = DomainEventType> = {
  /** The outbox row id, as a string: unique, increasing, the dedupe key. */
  id: string;
  type: T;
  version: number;
  aggregateType: string;
  aggregateId: string;
  payload: DomainEventCatalog[T];
  occurredAt: string;
};
