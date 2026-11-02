import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { APPLICANT_SCORE_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { ApplicantScoreService } from './applicant-score.service';

/** Every two minutes: a new applicant is ranked shortly after applying. */
const SWEEP_MS = 2 * 60 * 1000;
/** A sweep is up to twenty model calls: the lock must outlast it. */
const LOCK_MS = 10 * 60 * 1000;

@Injectable()
export class ApplicantScoreScheduler implements OnModuleInit {
  private readonly logger = new Logger(ApplicantScoreScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly scores: ApplicantScoreService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker(
      APPLICANT_SCORE_QUEUE,
      async () => {
        const done = await this.scores.sweep();
        if (done > 0) this.logger.log(`Applicants scored: ${done}`);
      },
      { concurrency: 1, lockDuration: LOCK_MS, stalledInterval: LOCK_MS / 2 },
    );
    try {
      const queue = this.queueService.getQueue(APPLICANT_SCORE_QUEUE);
      await queue.add('sweep', {}, { repeat: { every: SWEEP_MS } });
      // Once at start too, without waiting two minutes.
      await queue.add('sweep-now', {}, { removeOnComplete: true });
    } catch (err) {
      this.logger.error('Failed to register the applicant score sweep', err);
    }
  }
}
