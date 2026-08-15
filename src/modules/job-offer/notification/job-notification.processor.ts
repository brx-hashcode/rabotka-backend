import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JOB_NOTIFICATION_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { JobNotificationService } from './job-notification.service';

export type JobNotificationJobData = { jobOfferId: string };

/**
 * How long to wait before ranking a freshly posted offer.
 *
 * `create` kicks off geocoding and vector indexing without awaiting them, and
 * both feed the ranker — coordinates for proximity, the index for retrieval.
 * Waiting a little and re-reading the offer gets that ordering without wiring
 * the notification to two other async subsystems, where a geocoding failure
 * would take delivery down with it.
 */
export const NOTIFY_DELAY_MS = 30_000;

/**
 * Runs the fan-out off a queue rather than off a floating promise.
 *
 * The WhatsApp send is a live HTTP call — `WhatsAppService.sendTemplateMessage`
 * is not itself queued — so twenty recipients used to mean twenty un-retried
 * requests hanging off a detached chain, lost on restart and visible only as a
 * warning log. BullMQ's default three attempts with backoff covers all of that.
 */
@Injectable()
export class JobNotificationProcessor implements OnModuleInit {
  private readonly logger = new Logger(JobNotificationProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly notifications: JobNotificationService,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<JobNotificationJobData>(
      JOB_NOTIFICATION_QUEUE,
      // Deliberately not caught: a throw is what earns the retry. Every
      // partial-failure case that should NOT be retried is already absorbed
      // inside the service, per recipient.
      async (job) => {
        await this.notifications.notifyForOffer(job.data.jobOfferId);
      },
      { concurrency: 2 },
    );
    this.logger.log('JobNotificationProcessor ready');
  }

  /**
   * `jobId` keyed on the offer, so a duplicated create cannot fan out twice —
   * BullMQ drops an add whose id is already present.
   */
  async enqueue(jobOfferId: string): Promise<void> {
    const queue = this.queueService.getQueue(JOB_NOTIFICATION_QUEUE);
    await queue.add('notify', { jobOfferId } satisfies JobNotificationJobData, {
      jobId: `notify:${jobOfferId}`,
      delay: NOTIFY_DELAY_MS,
    });
  }
}
