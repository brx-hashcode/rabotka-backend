import { createConnection } from 'node:net';
import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

loadEnv({ path: '.env.local' });
loadEnv(); // .env (envFilePath order: .env.local, .env)

const logger = new Logger('Worker');

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

async function bootstrap() {
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

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.enableShutdownHooks();

  logger.log('Email queue worker is running');
}

async function main(): Promise<void> {
  try {
    await bootstrap();
  } catch (error: unknown) {
    logger.error('Worker failed to start:', error);
    process.exit(1);
  }
}

void main();
