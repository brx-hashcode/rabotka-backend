import { CV_ANALYSIS_QUEUE } from '../../../common/services/queue/queue.module';
import type { QueueService } from '../../../common/services/queue/queue.service';

/** One application whose CV is to be analysed for its offer. */
export type CvAnalysisJob = {
  /** A Rabotka application, or one from the careers page. */
  kind: 'rabotka' | 'careers';
  applicationId: string;
  offerId: string;
  /** The business's profile: whose « CV inclus » it uses. */
  employerId: string;
};

/**
 * Queues the analysis of one application. Its id is the application's, so the
 * same one is never queued twice while waiting or running; it is removed as
 * soon as it ends, so the application can be queued again once the plan has
 * « CV inclus » anew (otherwise a kept job would block that for hours).
 */
export async function enqueueCvAnalysis(
  queue: QueueService,
  job: CvAnalysisJob,
): Promise<void> {
  await queue.getQueue(CV_ANALYSIS_QUEUE).add(CV_ANALYSIS_QUEUE, job, {
    jobId: `${job.kind}-${job.applicationId}`,
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/**
 * Of these applications, those whose analysis is waiting or running in the
 * queue: a job is removed as soon as it ends, so one that is there is still
 * to come. The queue out of reach: none, rather than failing the caller.
 */
export async function queuedCvAnalyses(
  queue: QueueService,
  kind: CvAnalysisJob['kind'],
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const q = queue.getQueue(CV_ANALYSIS_QUEUE);
    const jobs = await Promise.all(ids.map((id) => q.getJob(`${kind}-${id}`)));
    return new Set(ids.filter((_, i) => !!jobs[i]));
  } catch {
    return new Set();
  }
}
