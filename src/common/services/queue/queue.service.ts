import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueOptions, Worker, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../redis/redis.constants';
import { EMAIL_QUEUE } from './queue.module';

const BULLMQ_PREFIX = 'bull:rabotka';

export type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};

export type EmailJobData = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  from?: string;
  fromName?: string;
  attachments?: MailAttachment[];
};

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues: Map<string, Queue> = new Map();
  private readonly workers: Map<string, Worker> = new Map();
  private readonly queueConnections: Redis[] = [];
  private readonly redisConnection: Redis;

  constructor(
    @Inject(REDIS_CONNECTION)
    redisConnection: Redis,
    private readonly configService: ConfigService,
  ) {
    this.redisConnection = redisConnection;
  }

  onModuleInit() {
    this.logger.log('✅ Queue service initialized');
  }

  async onModuleDestroy() {
    await Promise.all([
      ...Array.from(this.workers.values()).map((w) => w.close()),
      ...Array.from(this.queues.values()).map((q) => q.close()),
    ]);
    this.queueConnections.forEach((c) => c.disconnect());
  }

  getQueue(name: string, options?: QueueOptions): Queue {
    if (this.queues.has(name)) {
      return this.queues.get(name)!;
    }

    const queueConn = this.redisConnection.duplicate({ maxRetriesPerRequest: null });
    this.queueConnections.push(queueConn);

    const queue = new Queue(name, {
      connection: queueConn,
      prefix: BULLMQ_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 3600,
          count: 1000,
        },
        removeOnFail: {
          age: 86400,
        },
        ...options?.defaultJobOptions,
      },
      ...options,
    });

    this.queues.set(name, queue);
    return queue;
  }

  createWorker<T = unknown>(
    queueName: string,
    processor: (job: { id?: string; data: T }) => Promise<void>,
    options?: Omit<WorkerOptions, 'connection'>,
  ): Worker {
    if (this.workers.has(queueName)) {
      this.logger.warn(`Worker for queue ${queueName} already exists`);
      return this.workers.get(queueName)!;
    }

    const defaultConcurrency =
      this.configService?.get<number>('QUEUE_CONCURRENCY', 5) ?? 5;
    const concurrency =
      options?.concurrency && options.concurrency > 0
        ? options.concurrency
        : defaultConcurrency;

    const validConcurrency =
      typeof concurrency === 'number' &&
      concurrency > 0 &&
      Number.isFinite(concurrency)
        ? concurrency
        : 5;

    const { concurrency: _concurrency, ...restOptions } = options ?? {};

    const workerConnection = this.redisConnection.duplicate({
      maxRetriesPerRequest: null,
    });

    const worker = new Worker(
      queueName,
      async (job) => {
        this.logger.debug(`Processing job ${job.id} from queue ${queueName}`);
        await processor(job);
      },
      {
        connection: workerConnection,
        prefix: BULLMQ_PREFIX,
        concurrency: validConcurrency,
        ...restOptions,
      },
    );

    worker.on('completed', (job) => {
      const jobType =
        (job.data &&
          (job.data as { type?: string; jobType?: string; name?: string })
            .name) ??
        job.name;
      this.logger.log(
        `Job ${job.id} (${jobType}) completed in queue ${queueName}`,
      );
    });

    worker.on('failed', (job, err) => {
      const jobType =
        (job?.data &&
          (job.data as { type?: string; jobType?: string; name?: string })
            .name) ??
        job?.name;
      this.logger.error(
        `Job ${job?.id} (${jobType}) failed in queue ${queueName}: ${err.message}`,
      );
    });

    worker.on('error', (err) => {
      this.logger.error(`Worker error in queue ${queueName}: ${err.message}`);
    });

    this.workers.set(queueName, worker);
    this.logger.log(`✅ Worker created for queue ${queueName}`);
    return worker;
  }

  async addJob<T = unknown>(
    queueName: string,
    data: T,
    options?: {
      delay?: number;
      priority?: number;
      jobId?: string;
      repeat?: {
        pattern?: string;
        every?: number;
        limit?: number;
      };
    },
  ): Promise<string | undefined> {
    const queue = this.getQueue(queueName);
    const job = await queue.add(queueName, data, {
      delay: options?.delay,
      priority: options?.priority,
      jobId: options?.jobId,
      repeat: options?.repeat,
    });
    this.logger.debug(`Job [${job.id}] added to queue ${queueName}`);
    return job.id;
  }

  async addEmailJob(data: EmailJobData): Promise<string | undefined> {
    const { to, subject, text, html } = data;
    if (text === undefined && html === undefined) {
      throw new Error(
        'Email body is required: provide at least one of text or html',
      );
    }
    this.logger.log(
      `📧 Enqueuing email job to ${to} with subject: "${subject}"`,
    );

    try {
      const job = await this.getQueue(EMAIL_QUEUE).add(EMAIL_QUEUE, data);
      this.logger.log(
        `✅ Email job [${job.id}] successfully enqueued to ${EMAIL_QUEUE} - Recipient: ${to}, Subject: "${subject}"`,
      );
      return job.id;
    } catch (error) {
      this.logger.error(
        `❌ Failed to enqueue email job to ${to} with subject "${subject}":`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    const queuePromises = Array.from(this.queues.values()).map((queue) =>
      queue.close(),
    );
    const workerPromises = Array.from(this.workers.values()).map((worker) =>
      worker.close(),
    );

    await Promise.all([...queuePromises, ...workerPromises]);
    this.queues.clear();
    this.workers.clear();
    this.logger.log('All queues and workers closed');
  }
}
