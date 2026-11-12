import { Injectable, OnModuleInit } from '@nestjs/common';
import { INTERVIEW_REPORT_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import {
  InterviewReportService,
  type InterviewReportJob,
} from './interview-report.service';

/**
 * Two reports at a time: each is one or two model calls of several seconds,
 * on the providers' limits shared with VoVa and the CV analyses.
 */
const CONCURRENCY = 2;

/** « Rédiger le compte rendu », written off the request: the page is never held. */
@Injectable()
export class InterviewReportScheduler implements OnModuleInit {
  constructor(
    private readonly queueService: QueueService,
    private readonly reports: InterviewReportService,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<InterviewReportJob>(
      INTERVIEW_REPORT_QUEUE,
      async (job) => this.reports.generate(job.data),
      { concurrency: CONCURRENCY },
    );
  }
}
