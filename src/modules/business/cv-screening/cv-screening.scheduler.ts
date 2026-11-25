import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AnswerFilesService } from '../../answer-files/answer-files.service';
import {
  CV_SCREENING_QUEUE,
  CV_SCREENING_SWEEP_QUEUE,
} from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { CvRetentionService } from './cv-retention.service';
import {
  CvScreeningService,
  type CvScreeningJob,
} from './cv-screening.service';

/** Hourly: a stuck CV is given up after two hours, a purge is by the day. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Three CVs at a time: each is one model call of several seconds, and the
 * providers' rate limits are shared with VoVa.
 */
const CONCURRENCY = 3;

@Injectable()
export class CvScreeningScheduler implements OnModuleInit {
  private readonly logger = new Logger(CvScreeningScheduler.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly screenings: CvScreeningService,
    private readonly retention: CvRetentionService,
    // « Fichier » answers follow the CVs' retention, on the same hourly sweep.
    @Optional() private readonly answerFiles?: AnswerFilesService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queueService.createWorker<CvScreeningJob>(
      CV_SCREENING_QUEUE,
      async (job) => this.screenings.process(job.data.resumeId),
      { concurrency: CONCURRENCY },
    );

    this.queueService.createWorker(
      CV_SCREENING_SWEEP_QUEUE,
      async () => {
        // First, and failing the run if it fails: the purge reads these dates.
        await this.retention.refresh();
        const result = await this.screenings.sweep();
        if (result.stuck > 0 || result.purged > 0) {
          this.logger.log(
            `CV screenings: ${result.stuck} stuck given up, ${result.purged} purged`,
          );
        }
        const files = (await this.answerFiles?.sweep()) ?? 0;
        if (files > 0) {
          this.logger.log(`Answer files: ${files} purged`);
        }
        const told = await this.retention.announce();
        if (told > 0) {
          this.logger.log(`CV expiry: ${told} businesses told`);
        }
        const careers = await this.screenings.backfillCareers();
        if (careers > 0) {
          this.logger.log(`CV screenings: ${careers} careers read`);
        }
      },
      { concurrency: 1 },
    );

    try {
      await this.queueService
        .getQueue(CV_SCREENING_SWEEP_QUEUE)
        .add(
          'sweep',
          { type: 'sweep' },
          { repeat: { every: SWEEP_INTERVAL_MS } },
        );
      // Once at start too: CVs analysed before the career was read get it
      // without waiting an hour.
      await this.queueService
        .getQueue(CV_SCREENING_SWEEP_QUEUE)
        .add('sweep-now', { type: 'sweep' }, { removeOnComplete: true });
    } catch (err) {
      this.logger.error('Failed to register the CV screening sweep', err);
    }
  }
}
