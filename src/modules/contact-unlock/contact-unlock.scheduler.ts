import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  OnModuleInit,
} from '@nestjs/common';
import { ContactUnlockService } from './contact-unlock.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { CONTACT_UNLOCK_QUEUE } from '../../common/services/queue/queue.module';

type ContactUnlockJobData = { type: 'scan' };

const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class ContactUnlockScheduler implements OnModuleInit {
  private readonly logger = new Logger(ContactUnlockScheduler.name);

  constructor(
    private readonly contactUnlockService: ContactUnlockService,
    @Inject(forwardRef(() => BotNotificationService))
    private readonly botNotification: BotNotificationService,
    private readonly queueService: QueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<ContactUnlockJobData>(
      CONTACT_UNLOCK_QUEUE,
      (job) => this.process(job),
      { concurrency: 1 },
    );

    try {
      const queue = this.queueService.getQueue(CONTACT_UNLOCK_QUEUE);
      await queue.add('scan', { type: 'scan' } satisfies ContactUnlockJobData, {
        repeat: { every: SCAN_INTERVAL_MS },
      });
      this.logger.log(
        `ContactUnlockScheduler ready — scan every ${SCAN_INTERVAL_MS / 60000} min`,
      );
    } catch (err) {
      this.logger.error(
        'Failed to register contact-unlock repeatable scan — expired unlocks will not be processed',
        err,
      );
      throw err;
    }
  }

  async process(job: { data: ContactUnlockJobData }): Promise<void> {
    if (job.data.type === 'scan') {
      await this.handleExpiredUnlocks();
    }
  }

  async handleExpiredUnlocks(): Promise<void> {
    this.logger.log('Processing expired contact unlock attempts…');
    const conversions =
      await this.contactUnlockService.processExpiredAttempts();
    for (const { profileId, amount } of conversions) {
      await this.botNotification
        .sendContactUnlockCreditConversionNotification(profileId, amount)
        .catch((err) =>
          this.logger.warn(
            `Failed to send credit conversion notification to ${profileId}`,
            err,
          ),
        );
    }
  }
}
