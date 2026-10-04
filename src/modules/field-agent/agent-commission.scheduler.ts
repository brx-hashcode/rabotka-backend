import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AGENT_COMMISSION_QUEUE } from '../../common/services/queue/queue.module';
import { QueueService } from '../../common/services/queue/queue.service';
import { AgentCommissionService } from './agent-commission.service';

type AgentCommissionJob = { type: 'sweep' };

/**
 * Often enough that an agent sees a new placement's commission within minutes
 * of the unlock; the confirmation window it then waits out is hours.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class AgentCommissionScheduler implements OnModuleInit {
  private readonly logger = new Logger(AgentCommissionScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly commissions: AgentCommissionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<AgentCommissionJob>(
      AGENT_COMMISSION_QUEUE,
      async () => {
        const result = await this.commissions.sweep();
        if (Object.values(result).some((n) => n > 0)) {
          this.logger.log(
            `Agent commissions: ${result.decided} decided, ${result.started} windows started, ` +
              `${result.released} released, ${result.cancelled} cancelled`,
          );
        }
      },
      { concurrency: 1 },
    );

    try {
      await this.queueService
        .getQueue(AGENT_COMMISSION_QUEUE)
        .add('sweep', { type: 'sweep' } satisfies AgentCommissionJob, {
          repeat: { every: SWEEP_INTERVAL_MS },
        });
    } catch (err) {
      // Nothing is lost: the next successful registration decides every
      // placement still undecided.
      this.logger.error('Failed to register the agent-commission sweep', err);
    }
  }
}
