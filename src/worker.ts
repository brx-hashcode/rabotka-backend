import { createConnection } from 'node:net';
import { config as loadEnv } from 'dotenv';
import type { LoggerService } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

loadEnv({ path: '.env.local' });
loadEnv(); // .env (envFilePath order: .env.local, .env)

/**
 * Custom logger that only shows worker-related logs
 */
class WorkerLogger implements LoggerService {
  private readonly allowedContexts = ['Worker', 'MailProcessor', 'Queue'];

  log(message: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.log(`[${context || 'Worker'}] ${message}`);
    }
  }

  error(message: string, trace?: string, context?: string) {
    if (!context || this.allowedContexts.includes(context)) {
      console.error(`[${context || 'Worker'}] ${message}`, trace || '');
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

  // Set environment variable to indicate we're running as a queue worker
  process.env.RUN_QUEUE_WORKER = 'true';

  logger.log('🚀 Starting queue worker process...');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new WorkerLogger(),
  });

  app.enableShutdownHooks();

  logger.log('✅ Queue worker initialized successfully');
  logger.log('📋 Listening for jobs...');

  const shutdown = async (signal: string) => {
    logger.log(`\n${signal} received. Shutting down queue worker...`);

    try {
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

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Worker');
  logger.error('Worker failed to start:', error);
  process.exit(1);
});
