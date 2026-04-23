import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';
import { PENALTY_NOTIFICATIONS_QUEUE } from '../../common/services/queue/queue.module';
import type { PenaltyNotificationJobData } from './penalty-notification.processor';

const SCAN_INTERVAL_MS = 60 * 60 * 1000;

@Injectable()
export class PenaltyNotificationScheduler implements OnModuleInit {
  private readonly logger = new Logger(PenaltyNotificationScheduler.name);

  constructor(private readonly queueService: QueueService) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queueService.getQueue(PENALTY_NOTIFICATIONS_QUEUE);

    try {
      await queue.add('scan', { type: 'scan' } as PenaltyNotificationJobData, {
        repeat: { every: SCAN_INTERVAL_MS },
      });
      this.logger.log(
        `Repeatable scan job added to ${PENALTY_NOTIFICATIONS_QUEUE} (every ${SCAN_INTERVAL_MS / 60000} min)`,
      );
    } catch (err) {
      this.logger.error(
        'Failed to add repeatable penalty-notification scan job — penalty notifications will not run',
        err,
      );
      throw err;
    }
  }
}
