import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AgentStatus, ApplicationStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  APPLICATION_ACCEPTED_EVENT,
  type ApplicationAcceptedPayload,
} from '../../common/events/application-accepted.event';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import type { AgentNotificationInput } from './agent-notification-catalog';
import { AgentNotificationService } from './agent-notification.service';

type OutboxRow = {
  id: bigint;
  kind: string;
  entity_id: string;
  payload: Record<string, unknown>;
};

/** Which application statuses the agent hears about, and as what. */
const PLACEMENT_TYPES: Partial<
  Record<
    ApplicationStatus,
    | 'PLACEMENT_ACCEPTED'
    | 'PLACEMENT_STARTED'
    | 'PLACEMENT_COMPLETED'
    | 'PLACEMENT_ENDED'
  >
> = {
  ACCEPTED: 'PLACEMENT_ACCEPTED',
  STARTED: 'PLACEMENT_STARTED',
  END: 'PLACEMENT_COMPLETED',
  REJECTED: 'PLACEMENT_ENDED',
  CANCELLED: 'PLACEMENT_ENDED',
};

const BATCH = 500;
const POLL_MS = 30_000;
const RECONNECT_MS = 5_000;
const KEEP_PROCESSED_DAYS = 7;

/**
 * Turns the trigger-written outbox (see the agent_notifications migration)
 * into agent notifications. A Postgres LISTEN wakes it as soon as a row is
 * written; a poll covers a dropped connection or a missed wake-up.
 *
 * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several API instances
 * never process the same one. Claiming marks them processed: a crash between
 * the claim and the notification loses that notification rather than sending
 * it twice — the bell is a convenience, the facts live elsewhere.
 */
@Injectable()
export class AgentEventsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentEventsConsumer.name);
  private listener: Client | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reconnect: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: AgentNotificationService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    // Specs build the module without a database to listen to.
    if (process.env.NODE_ENV === 'test') return;
    void this.listen();
    this.poll = setInterval(() => this.wake(), POLL_MS);
    this.wake();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.reconnect) clearTimeout(this.reconnect);
    await this.listener?.end().catch(() => undefined);
  }

  /** Coalesces wake-ups: one drain at a time, and one more if woken meanwhile. */
  wake(): void {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = this.drain()
      .catch((err) => this.logger.error('Agent events drain failed', err))
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
      this.logger.warn(`Agent events listener lost: ${err.message}`);
      retry();
    });
    try {
      await client.connect();
      await client.query('LISTEN agent_events');
      this.listener = client;
      // Anything written while we were not listening.
      this.wake();
    } catch (err) {
      this.logger.warn(`Agent events listener failed: ${String(err)}`);
      retry();
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const rows = await this.prisma.$queryRaw<OutboxRow[]>`
        UPDATE agent_event_outbox SET processed_at = now()
        WHERE id IN (
          SELECT id FROM agent_event_outbox
          WHERE processed_at IS NULL
          ORDER BY id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, kind, entity_id, payload`;
      if (rows.length === 0) break;

      for (const row of rows.filter((r) => r.kind === 'placement_status')) {
        await this.placement(row).catch((err) =>
          this.logger.error(`Placement event ${row.id} failed`, err),
        );
      }
      // Not an agent concern: handed to whoever listens (the similar-hire
      // nudge), so this module stays unaware of them.
      for (const row of rows.filter((r) => r.kind === 'application_accepted')) {
        this.emitAccepted(row);
      }
      const jobs = rows.filter((r) => r.kind === 'job_active');
      if (jobs.length > 0) {
        await this.newJobs(jobs.map((r) => r.entity_id)).catch((err) =>
          this.logger.error('New-job events failed', err),
        );
      }
      if (rows.length < BATCH) break;
    }

    await this.prisma.$executeRaw`
      DELETE FROM agent_event_outbox
      WHERE processed_at < now() - make_interval(days => ${KEEP_PROCESSED_DAYS})`;
  }

  private emitAccepted(row: OutboxRow): void {
    const workerId = row.payload.workerId;
    const jobOfferId = row.payload.jobOfferId;
    if (typeof workerId !== 'string' || typeof jobOfferId !== 'string') return;
    try {
      this.events.emit(APPLICATION_ACCEPTED_EVENT, {
        applicationId: row.entity_id,
        workerId,
        jobOfferId,
      } satisfies ApplicationAcceptedPayload);
    } catch (err) {
      this.logger.error(`application_accepted ${row.id} failed`, err);
    }
  }

  private async placement(row: OutboxRow): Promise<void> {
    const to = row.payload.to as ApplicationStatus;
    const type = PLACEMENT_TYPES[to];
    if (!type) return;

    const application = await this.prisma.application.findUnique({
      where: { id: row.entity_id },
      select: {
        agent_id: true,
        job_offer: { select: { id: true, title: true } },
        worker: { select: { first_name: true, last_name: true } },
      },
    });
    if (!application?.agent_id) return;

    await this.notifications.notify(
      application.agent_id,
      {
        type,
        workerName:
          `${application.worker.first_name} ${application.worker.last_name}`.trim(),
        jobTitle: application.job_offer.title,
        jobId: application.job_offer.id,
      },
      `placement:${row.entity_id}:${to}`,
    );
  }

  /**
   * One notification per agent per batch, however many jobs opened: a seed
   * or an import of 300 offers says "300 nouvelles offres", once.
   */
  private async newJobs(jobIds: string[]): Promise<void> {
    const jobs = await this.prisma.jobOffer.findMany({
      where: { id: { in: jobIds }, status: 'ACTIVE', deleted_at: null },
      select: { id: true, title: true, city: true, country_code: true },
    });
    if (jobs.length === 0) return;

    const places = [
      ...new Map(
        jobs
          .filter((j) => j.city)
          .map((j) => [`${j.country_code ?? ''}|${j.city}`, j]),
      ).values(),
    ];
    const zones = await this.prisma.agentZone.findMany({
      where: {
        agent: { status: AgentStatus.ACTIVE },
        OR: places.map((j) => ({
          city: j.city!,
          ...(j.country_code ? { country_code: j.country_code } : {}),
        })),
      },
      select: { agent_id: true, country_code: true, city: true },
    });

    const byAgent = new Map<string, typeof jobs>();
    for (const z of zones) {
      const matching = jobs.filter(
        (j) =>
          j.city === z.city &&
          (!j.country_code || j.country_code === z.country_code),
      );
      const list = byAgent.get(z.agent_id) ?? [];
      for (const j of matching) if (!list.includes(j)) list.push(j);
      byAgent.set(z.agent_id, list);
    }

    for (const [agentId, list] of byAgent) {
      if (list.length === 0) continue;
      const single = list.length === 1 ? list[0] : null;
      const input: AgentNotificationInput = {
        type: 'NEW_JOBS_IN_ZONE',
        count: list.length,
        job: single
          ? { id: single.id, title: single.title, city: single.city ?? '' }
          : null,
        cities: list.map((j) => j.city ?? '').filter(Boolean),
      };
      await this.notifications.notify(
        agentId,
        input,
        single ? `job:${single.id}:${agentId}` : undefined,
      );
    }
  }
}
