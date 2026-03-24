import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import type { ReminderJobData } from './reminder.processor';

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const DEV_LOG_INTERVAL_MS = 10 * 1000;

@Injectable()
export class ReminderSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(ReminderSchedulerService.name);

  constructor(private readonly queueService: QueueService) {}

  onModuleInit(): void {
    const queue = this.queueService.getQueue(WHATSAPP_REMINDERS_QUEUE);
    queue
      .add('scan', { type: 'scan' } as ReminderJobData, {
        repeat: {
          every: SCAN_INTERVAL_MS,
        },
      })
      .then(() => {
        this.logger.log(
          `Repeatable scan job added to ${WHATSAPP_REMINDERS_QUEUE} (every ${SCAN_INTERVAL_MS / 60000} min)`,
        );
      })
      .catch((err) => {
        this.logger.warn('Failed to add repeatable reminder scan job', err);
      });

    if (process.env.NODE_ENV !== 'production') {
      setInterval(() => {
        const now = new Date().toISOString();
        this.logger.debug(
          `[DEV] Reminder scanner alive — queue: ${WHATSAPP_REMINDERS_QUEUE} | scan every ${SCAN_INTERVAL_MS / 60000}min | ${now}`,
        );
      }, DEV_LOG_INTERVAL_MS);
    }
  }
}
