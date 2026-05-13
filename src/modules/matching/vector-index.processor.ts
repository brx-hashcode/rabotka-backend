import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';
import { VECTOR_INDEX_QUEUE } from '../../common/services/queue/queue.module';
import { MatchingService } from './matching.service';

export type VectorIndexJobData =
  | { type: 'scan' }
  | { type: 'index_job'; jobOfferId: string }
  | { type: 'index_worker'; profileId: string }
  | { type: 'index_employer'; profileId: string };

const SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class VectorIndexProcessor implements OnModuleInit {
  private readonly logger = new Logger(VectorIndexProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly matchingService: MatchingService,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<VectorIndexJobData>(
      VECTOR_INDEX_QUEUE,
      async (job) => {
        const { data } = job;
        if (data.type === 'scan') {
          await this.matchingService.reindexPending();
          await this.scheduleScan();
          return;
        }
        if (data.type === 'index_job') {
          await this.matchingService.indexJobOffer(data.jobOfferId);
          return;
        }
        if (data.type === 'index_worker') {
          await this.matchingService.indexWorkerProfile(data.profileId);
          return;
        }
        if (data.type === 'index_employer') {
          await this.matchingService.indexEmployerProfile(data.profileId);
        }
      },
      { concurrency: 1 },
    );

    void this.scheduleScan();
    this.logger.log('VectorIndexProcessor ready');
  }

  async enqueueJob(jobOfferId: string): Promise<void> {
    const queue = this.queueService.getQueue(VECTOR_INDEX_QUEUE);
    await queue.add('index_job', { type: 'index_job', jobOfferId });
  }

  async enqueueWorker(profileId: string): Promise<void> {
    const queue = this.queueService.getQueue(VECTOR_INDEX_QUEUE);
    await queue.add('index_worker', { type: 'index_worker', profileId });
  }

  async enqueueEmployer(profileId: string): Promise<void> {
    const queue = this.queueService.getQueue(VECTOR_INDEX_QUEUE);
    await queue.add('index_employer', { type: 'index_employer', profileId });
  }

  private async scheduleScan(): Promise<void> {
    try {
      const queue = this.queueService.getQueue(VECTOR_INDEX_QUEUE);
      await queue.add('scan', { type: 'scan' }, { delay: SCAN_INTERVAL_MS });
    } catch (err) {
      this.logger.error('Failed to schedule next vector index scan', err);
    }
  }
}
