import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';
import { IDENTITY_CHECK_QUEUE } from '../../common/services/queue/queue.module';
import { SWEEP_INTERVAL_MS } from './identity-check.constants';
import {
  IdentityCheckService,
  type IdentityCheckJob,
} from './identity-check.service';
import { IdentityCheckWebhookService } from './identity-check-webhook.service';

@Injectable()
export class IdentityCheckProcessor implements OnModuleInit {
  private readonly logger = new Logger(IdentityCheckProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly checks: IdentityCheckService,
    private readonly webhooks: IdentityCheckWebhookService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<IdentityCheckJob>(
      IDENTITY_CHECK_QUEUE,
      async ({ data }) => {
        switch (data.type) {
          case 'send_consent':
            await this.checks.sendConsent(data.checkId);
            return;
          case 'deliver_webhook':
            await this.webhooks.deliver(data.checkId);
            return;
          case 'sweep': {
            const { expired, purged } = await this.checks.sweep();
            if (expired || purged) {
              this.logger.log(
                `Identity checks: ${expired} expired, ${purged} claims purged`,
              );
            }
          }
        }
      },
      { concurrency: 5 },
    );

    try {
      await this.queueService
        .getQueue(IDENTITY_CHECK_QUEUE)
        .add('sweep', { type: 'sweep' } satisfies IdentityCheckJob, {
          repeat: { every: SWEEP_INTERVAL_MS },
        });
    } catch (err) {
      // Expired checks still close on the partner's next GET; only the
      // webhook for them waits until this is fixed.
      this.logger.error('Failed to register the identity-check sweep', err);
    }
  }
}
