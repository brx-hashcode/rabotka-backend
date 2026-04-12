import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import type { ReminderJobData } from './reminder.processor';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class ReminderSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ReminderSchedulerService.name);

  constructor(private readonly queueService: QueueService) {}

  async onModuleInit(): Promise<void> {
    const queue = this.queueService.getQueue(WHATSAPP_REMINDERS_QUEUE);

    try {
      await queue.add('scan', { type: 'scan' } as ReminderJobData, {
        repeat: { every: SCAN_INTERVAL_MS },
      });
      this.logger.log(
        `Repeatable scan job added to ${WHATSAPP_REMINDERS_QUEUE} (every ${SCAN_INTERVAL_MS / 60000} min)`,
      );
    } catch (err) {
      // Fatal: without the scan job the entire reminder system is non-functional.
      // Re-throw so NestJS startup fails loudly rather than silently degrading.
      this.logger.error('Failed to add repeatable reminder scan job — reminder system will not run', err);
      throw err;
    }
  }
}
