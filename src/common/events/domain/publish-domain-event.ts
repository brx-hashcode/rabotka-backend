import type { Prisma } from '@prisma/client';
import {
  DOMAIN_EVENT_AGGREGATES,
  type DomainEventCatalog,
  type DomainEventType,
} from './domain-event.catalog';

/**
 * Records a domain event in the caller's transaction.
 *
 * Pass the interactive-transaction client (`tx`), not PrismaService: the event
 * must exist if and only if the change it describes committed. A trigger wakes
 * DomainEventRelay at commit; nothing is sent from here.
 *
 * A plain function rather than a provider on purpose: a producer needs no new
 * constructor dependency (several services are built positionally in specs).
 */
export async function publishDomainEvent<T extends DomainEventType>(
  tx: Pick<Prisma.TransactionClient, 'domainEvent'>,
  type: T,
  aggregateId: string,
  payload: DomainEventCatalog[T],
  version = 1,
): Promise<void> {
  await tx.domainEvent.create({
    data: {
      type,
      version,
      aggregate_type: DOMAIN_EVENT_AGGREGATES[type],
      aggregate_id: aggregateId,
      payload,
    },
  });
}
