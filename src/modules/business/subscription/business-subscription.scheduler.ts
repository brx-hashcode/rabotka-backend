import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BUSINESS_SUBSCRIPTION_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { BusinessSubscriptionService } from './business-subscription.service';

type SweepJob = { type: 'sweep' };

/** Hourly: reminders are by the day, expiry within the hour is enough. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class BusinessSubscriptionScheduler implements OnModuleInit {
  private readonly logger = new Logger(BusinessSubscriptionScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<SweepJob>(
      BUSINESS_SUBSCRIPTION_QUEUE,
      async () => {
        const result = await this.subscriptions.sweep();
        if (result.reminded > 0 || result.expired > 0) {
          this.logger.log(
            `Business subscriptions: ${result.reminded} reminded, ${result.expired} expired`,
          );
        }
      },
      { concurrency: 1 },
    );

    try {
      await this.queueService
        .getQueue(BUSINESS_SUBSCRIPTION_QUEUE)
        .add('sweep', { type: 'sweep' } satisfies SweepJob, {
          repeat: { every: SWEEP_INTERVAL_MS },
        });
    } catch (err) {
      // Nothing is lost: expiry is also checked on every read (current()).
      this.logger.error(
        'Failed to register the business subscription sweep',
        err,
      );
    }
  }
}
