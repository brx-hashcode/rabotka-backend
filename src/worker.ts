import { createConnection } from 'node:net';
import { config as loadEnv } from 'dotenv';
import type { INestApplicationContext, LoggerService } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MailerService } from '@nestjs-modules/mailer';
import { AppModule } from './app.module';
import { QueueService } from './queue/queue.service';
import { EMAIL_QUEUE } from './queue/queue.module';
import type { EmailJobData } from './queue/queue.service';

loadEnv({ path: '.env.local' });
loadEnv();

class WorkerLogger implements LoggerService {
  private readonly allowedContexts = [
    'Worker',
    'QueueService',
    'MailProcessor',
    'RedisService',
    'ExceptionHandler',
  ];

  log(message: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.log(`[${context || 'Worker'}] ${message}`);
    }
  }

  error(message: unknown, trace?: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      const msg =
        message instanceof Error
          ? `${message.message}\n${message.stack ?? ''}`
          : String(message);
      console.error(`[${context || 'Worker'}] ${msg}`, trace ?? '');
    }
  }

  warn(message: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.warn(`[${context || 'Worker'}] ${message}`);
    }
  }

  debug(message: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.debug(`[${context || 'Worker'}] ${message}`);
    }
  }

  verbose(message: string, context?: string) {
    this.log(message, context);
  }
}

function checkRedis(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, timeout: 3000 }, () => {
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => reject(err));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const redisHost = process.env.REDIS_HOST ?? 'localhost';
  const redisPort = Number(process.env.REDIS_PORT ?? 6379);

  try {
    await checkRedis(redisHost, redisPort);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Cannot connect to Redis at ${redisHost}:${redisPort}. ${message}. ` +
        'Start Redis (e.g. docker compose up -d redis) and ensure REDIS_HOST/REDIS_PORT match.',
    );
    process.exit(1);
  }

  process.env.RUN_QUEUE_WORKER = 'true';

  logger.log('🚀 Starting queue worker process...');

  let app: INestApplicationContext;
  try {
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: new WorkerLogger(),
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      '[Worker] Nest failed to create application context:',
      message,
    );
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
    return;
  }

  const queueService = app.get(QueueService);
  if (!queueService) {
    logger.error('QueueService not found');
    await app.close();
    process.exit(1);
  }

  const mailerService = app.get(MailerService);
  if (!mailerService) {
    logger.error('MailerService not found');
    await app.close();
    process.exit(1);
  }

  queueService.createWorker<EmailJobData>(
    EMAIL_QUEUE,
    async (job) => {
      const { to, subject, template, context } = job.data;
      const jobId = job.id ?? 'unknown';
      console.log(
        `[MailProcessor] 📧 Processing email job [${jobId}] from ${EMAIL_QUEUE}: Recipient(s): ${to}, Subject: "${subject}"`,
      );
      await mailerService.sendMail({
        to,
        subject,
        template,
        context: context ?? {},
      });
      console.log(
        `[MailProcessor] ✅ Email sent successfully [${jobId}] to ${to} - Subject: "${subject}"`,
      );
    },
    { concurrency: Number(process.env.EMAIL_QUEUE_CONCURRENCY) || 5 },
  );

  app.enableShutdownHooks();

  logger.log('✅ Queue worker initialized successfully');
  logger.log('📋 Listening for jobs...');

  const shutdown = async (signal: string) => {
    logger.log(`\n${signal} received. Shutting down queue worker...`);

    try {
      if (queueService && typeof queueService.closeAll === 'function') {
        await queueService.closeAll();
      }
      await app.close();
      logger.log('✅ Queue worker shut down gracefully');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    void shutdown('UNCAUGHT_EXCEPTION');
  });
}

void bootstrap().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error('[Worker] Worker failed to start:', message);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
