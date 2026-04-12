import { createConnection } from 'node:net';
import { config as loadEnv } from 'dotenv';
import type {
  INestApplicationContext,
  LoggerService,
  LogLevel,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { MailerService } from '@nestjs-modules/mailer';
import { MailProcessor } from './modules/mail/mail.processor';
import { QueueService } from './common/services/queue/queue.service';
import {
  EMAIL_QUEUE,
  WHATSAPP_REMINDERS_QUEUE,
  PAYMENT_QUEUE,
} from './common/services/queue/queue.module';
import type { EmailJobData } from './common/services/queue/queue.service';
import { ReminderProcessor } from './modules/bot/reminder/reminder.processor';
import type { ReminderJobData } from './modules/bot/reminder/reminder.processor';
import { PaymentProcessor } from './modules/payments/payment.processor';
import type { PaymentJobData } from './modules/payments/payment.service';
import { WhatsAppOutboundProcessor } from './modules/whatsapp/whatsapp-outbound.processor';

loadEnv({ path: '.env.local' });
loadEnv();

class WorkerLogger implements LoggerService {
  /** Include Nest/module init contexts so startup is not silent (looks "stuck" otherwise). */
  private readonly allowedContexts = [
    'Worker',
    'QueueService',
    'MailProcessor',
    'RedisService',
    'ExceptionHandler',
    'NestFactory',
    'InstanceLoader',
    'PrismaService',
    'SystemConfigService',
    'WalletService',
    'WhatsAppService',
    'RedisModule',
    'BullModule',
    'ReminderProcessor',
    'PaymentProcessor',
    'WhatsAppOutboundProcessor',
  ];

  log(message: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.log(`[${context || 'Worker'}] ${message}`);
    }
  }

  error(message: unknown, trace?: string, context?: string) {
    const msg =
      message instanceof Error
        ? `${message.message}\n${message.stack ?? ''}`
        : String(message);
    console.error(`[${context || 'Worker'}] ${msg}`, trace ?? '');
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

function checkTcp(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(timeoutMs);
    socket.on('error', (err) => reject(err));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

function checkRedis(host: string, port: number): Promise<void> {
  return checkTcp(host, port, 3000);
}

function sanitizeDatabaseUrl(raw: string): string {
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  return s;
}

/**
 * Host/port for TCP preflight. Uses URL first, then `...@host:port/` (handles tricky passwords).
 */
function parseDatabaseHostPort(): { host: string; port: number } | null {
  const raw = sanitizeDatabaseUrl(
    process.env.DATABASE_URL?.trim() ??
      'postgresql://postgres:postgres@localhost:5433/rabotka',
  );
  try {
    const normalized = raw.replace(/^postgres(ql)?:/i, 'http:');
    const u = new URL(normalized);
    const host = u.hostname;
    const port = u.port ? Number(u.port) : 5432;
    if (host) return { host, port };
  } catch {
    // fall through
  }
  const withoutQuery = raw.split('?')[0] ?? raw;
  const atIdx = withoutQuery.lastIndexOf('@');
  const hostPart =
    atIdx >= 0
      ? withoutQuery.slice(atIdx + 1)
      : withoutQuery.replace(/^postgres(ql)?:\/\//i, '');
  const beforePath = hostPart.split('/')[0] ?? hostPart;
  const colon = beforePath.lastIndexOf(':');
  if (colon <= 0) {
    return beforePath ? { host: beforePath, port: 5432 } : null;
  }
  const host = beforePath.slice(0, colon);
  const port = Number(beforePath.slice(colon + 1));
  return host && Number.isFinite(port) && port > 0
    ? { host, port }
    : null;
}

async function ensureRedisAndPostgresReachable(logger: Logger): Promise<void> {
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

  const dbTarget = parseDatabaseHostPort();
  if (!dbTarget) {
    logger.warn(
      'Could not parse DATABASE_URL for a TCP preflight check; startup may hang if Postgres is down.',
    );
    return;
  }

  logger.log(
    `Checking PostgreSQL reachability at ${dbTarget.host}:${dbTarget.port}...`,
  );
  try {
    await checkTcp(dbTarget.host, dbTarget.port, 5000);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `Cannot reach PostgreSQL at ${dbTarget.host}:${dbTarget.port}. ${message}. ` +
        'Start Postgres (e.g. docker compose up -d postgres) and ensure DATABASE_URL matches.',
    );
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  await ensureRedisAndPostgresReachable(logger);

  process.env.RUN_QUEUE_WORKER = 'true';

  const reminderEnabled = process.env.RUN_REMINDER_WORKER !== 'false';
  logger.log(
    reminderEnabled
      ? '🚀 Starting queue worker process (email + reminders)...'
      : '🚀 Starting queue worker process (email only, RUN_REMINDER_WORKER=false)...',
  );

  const nestLogger: LogLevel[] | LoggerService =
    process.env.WORKER_QUIET_LOGS === 'true'
      ? new WorkerLogger()
      : (['log', 'warn', 'error', 'debug', 'verbose'] as LogLevel[]);

  let app: INestApplicationContext;
  try {
    app = await NestFactory.createApplicationContext(WorkerModule.forRoot(), {
      logger: nestLogger,
    });
    logger.log('Nest application context created');
  } catch (err: unknown) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error(`Nest failed to create application context: ${message}`);
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

  let reminderProcessor: ReminderProcessor | null = null;
  try {
    reminderProcessor = app.get(ReminderProcessor);
  } catch {
    logger.warn(
      'ReminderProcessor not found; reminder jobs will not be processed',
    );
  }

  const mailProcessor = app.get(MailProcessor);
  if (!mailProcessor) {
    logger.error('MailProcessor not found');
    await app.close();
    process.exit(1);
  }

  try {
    const mailerService = app.get(MailerService);
    mailProcessor.setMailerService(mailerService);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `MailerService not in context (${msg}); real email send will fail (mock mode may still work)`,
    );
  }

  queueService.createWorker<EmailJobData>(
    EMAIL_QUEUE,
    (job) => mailProcessor.processEmailJob(job),
    { concurrency: Number(process.env.EMAIL_QUEUE_CONCURRENCY) || 5 },
  );

  if (reminderProcessor) {
    queueService.createWorker<ReminderJobData>(
      WHATSAPP_REMINDERS_QUEUE,
      (job) => reminderProcessor.process(job),
      { concurrency: 2 },
    );
  }

  const paymentProcessor = app.get(PaymentProcessor);
  queueService.createWorker<PaymentJobData>(
    PAYMENT_QUEUE,
    (job) => paymentProcessor.process(job),
    { concurrency: 5 },
  );

  try {
    const outboundProcessor = app.get(WhatsAppOutboundProcessor);
    outboundProcessor.register(queueService);
    logger.log('WhatsApp outbound worker registered');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`WhatsAppOutboundProcessor not found (${msg}); outbound WhatsApp jobs will not be processed`);
  }

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
