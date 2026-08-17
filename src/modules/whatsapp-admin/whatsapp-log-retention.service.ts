import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { WHATSAPP_LOG_RETENTION_QUEUE } from '../../common/services/queue/queue.module';

/**
 * Ages out the WhatsApp delivery log.
 *
 * The table grows with every send and nothing else prunes it. 180 days is
 * chosen against what the rows are actually FOR: answering "did this arrive?"
 * during a support conversation, and comparing this month's delivery rate to
 * last quarter's. Nobody investigates a delivery failure from six months ago,
 * and Meta's own analytics only look back a year regardless.
 *
 * Deleted in batches rather than one statement: a single `DELETE` over months
 * of rows takes a long lock on a table the send path writes to on every
 * message, and a send blocking behind a cleanup job is a far worse outcome
 * than a cleanup that takes a few extra seconds.
 */

const RETENTION_DAYS = 180;
const BATCH_SIZE = 5_000;
/** Ceiling on one run, so a first run over a huge backlog cannot run forever. */
const MAX_BATCHES = 40;

type RetentionJob = { type: 'prune' };

@Injectable()
export class WhatsappLogRetentionService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappLogRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queueService.getQueue(WHATSAPP_LOG_RETENTION_QUEUE);

    try {
      // 03:30 daily — off the traffic peak, and offset from the top of the hour
      // where every other repeatable job in this codebase already fires.
      await queue.add(
        'whatsapp-log-prune',
        { type: 'prune' } satisfies RetentionJob,
        { repeat: { pattern: '30 3 * * *' } },
      );
    } catch (err) {
      // Logged, not rethrown. A missing prune schedule means the table grows;
      // it does not mean the application cannot serve requests, and taking the
      // API process down over a housekeeping job would be the larger outage.
      this.logger.error(
        'Failed to register the WhatsApp log retention job — the delivery ' +
          'log will grow unbounded until this is fixed',
        err,
      );
    }

    this.queueService.createWorker<RetentionJob>(
      WHATSAPP_LOG_RETENTION_QUEUE,
      async () => {
        await this.prune();
      },
      { concurrency: 1 },
    );
  }

  async prune(): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const rows = await this.prisma.whatsappMessage.findMany({
        where: { created_at: { lt: cutoff } },
        select: { id: true },
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;

      const result = await this.prisma.whatsappMessage.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      deleted += result.count;

      if (rows.length < BATCH_SIZE) break;
    }

    if (deleted > 0) {
      this.logger.log(
        `Pruned ${deleted} WhatsApp log rows older than ${RETENTION_DAYS} days`,
      );
    }
    return { deleted };
  }
}
