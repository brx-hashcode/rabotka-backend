import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { INTERVIEW_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { InterviewService } from './interview.service';

/** Every 15 minutes: a reminder lands about a day ahead, not up to an hour off. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class InterviewScheduler implements OnModuleInit {
  private readonly logger = new Logger(InterviewScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly interviews: InterviewService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker(
      INTERVIEW_QUEUE,
      async () => {
        const sent = await this.interviews.remind();
        if (sent > 0) this.logger.log(`Interviews: ${sent} reminded`);
      },
      { concurrency: 1 },
    );
    try {
      await this.queueService
        .getQueue(INTERVIEW_QUEUE)
        .add(
          'remind',
          { type: 'remind' },
          { repeat: { every: SWEEP_INTERVAL_MS } },
        );
    } catch (err) {
      this.logger.error('Failed to register the interview reminders', err);
    }
  }
}
