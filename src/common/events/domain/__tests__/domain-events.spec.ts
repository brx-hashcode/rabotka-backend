import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../services/prisma/prisma.service';
import type { QueueService } from '../../../services/queue/queue.service';
import {
  BullmqEventTransport,
  DomainEventBus,
  domainEventJobId,
  domainEventQueue,
  type EventTransport,
} from '../domain-event-bus.service';
import { DomainEventRelay } from '../domain-event-relay.service';
import { publishDomainEvent } from '../publish-domain-event';
import type { DomainEvent } from '../domain-event.catalog';

function row(id: number, type = 'payment.approved') {
  return {
    id: BigInt(id),
    type,
    version: 1,
    aggregate_type: 'payment_request',
    aggregate_id: `pr-${id}`,
    payload: { paymentRequestId: `pr-${id}` },
    occurred_at: new Date('2026-11-20T10:00:00Z'),
  };
}

function makeQueues() {
  const addBulk = jest.fn().mockResolvedValue([]);
  const queues = {
    getQueue: jest.fn().mockReturnValue({ addBulk }),
    createWorker: jest.fn(),
  };
  return { queues, addBulk };
}

function makeRelay(rows: ReturnType<typeof row>[], transport: EventTransport) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    $executeRaw: jest.fn().mockResolvedValue(rows.length),
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const { queues } = makeQueues();
  const bus = new DomainEventBus(queues as unknown as QueueService);
  const relay = new DomainEventRelay(
    prisma as unknown as PrismaService,
    { get: jest.fn() } as unknown as ConfigService,
    bus,
    transport,
  );
  return { relay, bus, tx, prisma };
}

describe('DomainEventBus', () => {
  it('lists the consumers of each event type', () => {
    const bus = new DomainEventBus(
      makeQueues().queues as unknown as QueueService,
    );
    bus.subscribe({
      consumer: 'a',
      events: ['payment.approved'],
      handle: jest.fn(),
    });
    expect(bus.consumersOf('payment.approved')).toEqual(['a']);
    expect(bus.consumersOf('other.event')).toEqual([]);
  });

  it('refuses a duplicate consumer and a subscription after start', () => {
    const { queues } = makeQueues();
    const bus = new DomainEventBus(queues as unknown as QueueService);
    bus.subscribe({
      consumer: 'a',
      events: ['payment.approved'],
      handle: jest.fn(),
    });
    expect(() =>
      bus.subscribe({
        consumer: 'a',
        events: ['payment.approved'],
        handle: jest.fn(),
      }),
    ).toThrow(/twice/);

    bus.start();
    expect(queues.createWorker).toHaveBeenCalledWith(
      'domain-events-a',
      expect.any(Function),
      { concurrency: 3 },
    );
    expect(() =>
      bus.subscribe({
        consumer: 'b',
        events: ['payment.approved'],
        handle: jest.fn(),
      }),
    ).toThrow(/after the relay started/);
  });

  it("hands each job's event to the consumer's handler", async () => {
    const { queues } = makeQueues();
    const bus = new DomainEventBus(queues as unknown as QueueService);
    const handle = jest.fn().mockResolvedValue(undefined);
    bus.subscribe({ consumer: 'a', events: ['payment.approved'], handle });
    bus.start();
    const processor = queues.createWorker.mock.calls[0][1];
    const event = { id: '1' } as DomainEvent;
    await processor({ data: event, attemptsMade: 0 });
    expect(handle).toHaveBeenCalledWith(event);
  });
});

describe('BullmqEventTransport', () => {
  it('enqueues on the consumer queue, deduped by event and consumer', async () => {
    const { queues, addBulk } = makeQueues();
    const transport = new BullmqEventTransport(
      queues as unknown as QueueService,
    );
    const event = { id: '42', type: 'payment.approved' } as DomainEvent;

    await transport.send('business-subscription', [event]);

    expect(queues.getQueue).toHaveBeenCalledWith(
      domainEventQueue('business-subscription'),
    );
    expect(addBulk).toHaveBeenCalledWith([
      {
        name: 'payment.approved',
        data: event,
        opts: { jobId: '42-business-subscription' },
      },
    ]);
  });

  it('builds job ids BullMQ accepts (no colon, not an integer)', () => {
    const id = domainEventJobId('7', 'careers');
    expect(id).not.toContain(':');
    expect(String(parseInt(id, 10))).not.toBe(id);
  });
});

describe('DomainEventRelay', () => {
  it('sends each row to every consumer of its type, then stamps them', async () => {
    const transport = { send: jest.fn().mockResolvedValue(undefined) };
    const { relay, bus, tx } = makeRelay([row(1), row(2)], transport);
    bus.subscribe({
      consumer: 'a',
      events: ['payment.approved'],
      handle: jest.fn(),
    });
    bus.subscribe({
      consumer: 'b',
      events: ['payment.approved'],
      handle: jest.fn(),
    });

    await expect(relay.relayBatch()).resolves.toBe(2);

    expect(transport.send).toHaveBeenCalledTimes(2);
    const [consumer, events] = transport.send.mock.calls[0];
    expect(consumer).toBe('a');
    expect(events.map((e: DomainEvent) => e.id)).toEqual(['1', '2']);
    expect(events[0]).toMatchObject({
      type: 'payment.approved',
      aggregateId: 'pr-1',
      occurredAt: '2026-11-20T10:00:00.000Z',
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transport.send.mock.invocationCallOrder[1]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
  });

  it('leaves the rows pending when the transport fails', async () => {
    const transport = {
      send: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const { relay, bus, tx } = makeRelay([row(1)], transport);
    bus.subscribe({
      consumer: 'a',
      events: ['payment.approved'],
      handle: jest.fn(),
    });

    await expect(relay.relayBatch()).rejects.toThrow('redis down');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('stamps a row nobody listens to, without sending it', async () => {
    const transport = { send: jest.fn() };
    const { relay, tx } = makeRelay([row(1, 'nobody.cares')], transport);

    await expect(relay.relayBatch()).resolves.toBe(1);
    expect(transport.send).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no row is pending', async () => {
    const transport = { send: jest.fn() };
    const { relay, tx } = makeRelay([], transport);

    await expect(relay.relayBatch()).resolves.toBe(0);
    expect(transport.send).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('publishDomainEvent', () => {
  it("writes the row through the caller's transaction", async () => {
    const tx = { domainEvent: { create: jest.fn().mockResolvedValue({}) } };

    await publishDomainEvent(tx as never, 'payment.approved', 'pr-1', {
      paymentRequestId: 'pr-1',
      requestType: 'BUSINESS_SUBSCRIPTION',
      profileId: 'p-1',
    });

    expect(tx.domainEvent.create).toHaveBeenCalledWith({
      data: {
        type: 'payment.approved',
        version: 1,
        aggregate_type: 'payment_request',
        aggregate_id: 'pr-1',
        payload: {
          paymentRequestId: 'pr-1',
          requestType: 'BUSINESS_SUBSCRIPTION',
          profileId: 'p-1',
        },
      },
    });
  });
});
