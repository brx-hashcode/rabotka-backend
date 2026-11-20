import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../../services/prisma/prisma.service';
import type { DomainEvent, DomainEventType } from './domain-event.catalog';
import {
  DomainEventBus,
  type EventTransport,
} from './domain-event-bus.service';

export const EVENT_TRANSPORT = Symbol('EVENT_TRANSPORT');

type Row = {
  id: bigint;
  type: string;
  version: number;
  aggregate_type: string;
  aggregate_id: string;
  payload: unknown;
  occurred_at: Date;
};

const BATCH = 200;
const POLL_MS = 30_000;
const RECONNECT_MS = 5_000;
const KEEP_RELAYED_DAYS = 30;
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Moves `domain_events` rows to their consumers, at least once.
 *
 * Same wake-up as AgentEventsConsumer: a Postgres LISTEN (the insert trigger
 * notifies at commit) plus a poll for a dropped connection or a missed
 * notification. Unlike it, a row is stamped relayed only *after* the transport
 * accepted it, inside the transaction that locked it: if the send fails, the
 * transaction rolls back and the rows are retried at the next wake-up. Several
 * API instances share the work through `FOR UPDATE SKIP LOCKED`, and the
 * transport's dedupe makes a re-send harmless.
 */
@Injectable()
export class DomainEventRelay
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DomainEventRelay.name);
  private listener: Client | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private lastPurge = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly bus: DomainEventBus,
    @Inject(EVENT_TRANSPORT) private readonly transport: EventTransport,
  ) {}

  onApplicationBootstrap(): void {
    // Specs build modules without a database or Redis behind them.
    if (process.env.NODE_ENV === 'test') return;
    this.bus.start();
    void this.listen();
    this.poll = setInterval(() => this.wake(), POLL_MS);
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.reconnect) clearTimeout(this.reconnect);
    await this.listener?.end().catch(() => undefined);
    await this.draining;
  }

  /** Coalesces wake-ups: one drain at a time, and one more if woken meanwhile. */
  wake(): void {
    if (this.stopped) return;
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain()
      .catch((err) => this.logger.error('Domain events relay failed', err))
      .finally(() => {
        this.draining = null;
        if (this.again && !this.stopped) {
          this.again = false;
          this.wake();
        }
      });
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    const url =
      this.config.get<string>('DIRECT_DATABASE_URL') ||
      this.config.get<string>('DATABASE_URL');
    if (!url) return;

    const client = new Client({ connectionString: url });
    const retry = () => {
      if (this.listener === client) this.listener = null;
      client.removeAllListeners();
      void client.end().catch(() => undefined);
      if (!this.stopped) {
        this.reconnect = setTimeout(() => void this.listen(), RECONNECT_MS);
      }
    };
    client.on('notification', () => this.wake());
    client.on('error', (err) => {
      this.logger.warn(`Domain events listener lost: ${err.message}`);
      retry();
    });
    try {
      await client.connect();
      await client.query('LISTEN domain_events');
      this.listener = client;
      // Anything written while we were not listening.
      this.wake();
    } catch (err) {
      this.logger.warn(`Domain events listener failed: ${String(err)}`);
      retry();
    }
  }

  /** Relays every pending row, batch by batch, then purges old ones. */
  async drain(): Promise<void> {
    while (!this.stopped && (await this.relayBatch()) === BATCH) {
      // A full batch: there may be more.
    }
    if (Date.now() - this.lastPurge > PURGE_EVERY_MS) {
      this.lastPurge = Date.now();
      await this.prisma.$executeRaw`
        DELETE FROM domain_events
        WHERE relayed_at < now() - make_interval(days => ${KEEP_RELAYED_DAYS})`;
    }
  }

  /** One batch, in one transaction. Returns how many rows it relayed. */
  async relayBatch(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Row[]>`
          SELECT id, type, version, aggregate_type, aggregate_id, payload, occurred_at
          FROM domain_events
          WHERE relayed_at IS NULL
          ORDER BY id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        if (rows.length === 0) return 0;

        const byConsumer = new Map<string, DomainEvent[]>();
        for (const row of rows) {
          const event = toEvent(row);
          for (const consumer of this.bus.consumersOf(row.type)) {
            const list = byConsumer.get(consumer) ?? [];
            list.push(event);
            byConsumer.set(consumer, list);
          }
        }
        // A throw here rolls the stamp back: the rows stay pending.
        for (const [consumer, events] of byConsumer) {
          await this.transport.send(consumer, events);
        }

        await tx.$executeRaw`
          UPDATE domain_events SET relayed_at = now()
          WHERE id IN (${Prisma.join(rows.map((r) => r.id))})`;
        return rows.length;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
  }
}

function toEvent(row: Row): DomainEvent {
  return {
    id: row.id.toString(),
    type: row.type as DomainEventType,
    version: row.version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload as DomainEvent['payload'],
    occurredAt: row.occurred_at.toISOString(),
  };
}
