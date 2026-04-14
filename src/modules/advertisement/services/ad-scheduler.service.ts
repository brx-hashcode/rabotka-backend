import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../../common/services/queue/queue.service';
import { AdProcessor, AdJobData } from './ad.processor';
import { AD_QUEUE } from '../advertisement.constants';

@Injectable()
export class AdSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(AdSchedulerService.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly adProcessor: AdProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queueService.getQueue(AD_QUEUE);

    try {
      // Hourly: activate APPROVED ads + complete expired ACTIVE ads
      await queue.add(
        'ad-lifecycle',
        { type: 'lifecycle' } satisfies AdJobData,
        { repeat: { pattern: '0 * * * *' } },
      );

      // Daily at 08:00: dispatch ads to targeted profiles
      await queue.add(
        'ad-dispatch',
        { type: 'dispatch' } satisfies AdJobData,
        { repeat: { pattern: '0 8 * * *' } },
      );

      this.logger.log(
        'Advertisement scheduler initialized: lifecycle (hourly) + dispatch (daily 08:00)',
      );
    } catch (err) {
      this.logger.error(
        'Failed to register advertisement repeatable jobs — ad scheduling will not run',
        err,
      );
      throw err;
    }

    // Register the worker
    this.queueService.createWorker<AdJobData>(
      AD_QUEUE,
      (job) => this.adProcessor.process(job),
      { concurrency: 1 },
    );
  }
}
