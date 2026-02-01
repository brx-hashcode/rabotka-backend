import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const logger = new Logger('Worker');

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  app.enableShutdownHooks();

  logger.log('Email queue worker is running');
}

bootstrap().catch((error: unknown) => {
  logger.error('Worker failed to start:', error);
  process.exit(1);
});
