import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CSRF_UTILITIES } from './csrf/csrf.constants';
import { csrfVisitorMiddleware } from './csrf/csrf-visitor.middleware';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  const configService = app.get(ConfigService);

  const port: number = configService.get<number>('PORT', 3000);

  const environment: string = configService.get<string>(
    'NODE_ENV',
    'development',
  );

  const allowOrigins = configService.get<string>(
    'ALLOW_ORIGINS',
    'http://localhost:3000',
  );

  const origins = allowOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins.length ? origins : ['http://localhost:3000'],
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

  app.use(cookieParser());
  app.use(csrfVisitorMiddleware);

  const csrfUtilities = app.get(CSRF_UTILITIES);
  app.use(csrfUtilities.doubleCsrfProtection);

  app.useGlobalInterceptors(new LoggingInterceptor());

  const config = new DocumentBuilder()
    .setTitle('Rabotka API Documentation')
    .setDescription('API documentation for Rabotka backend service')
    .setVersion('1.0')
    .addServer(`http://localhost:${port}`, 'Local Development Server')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  app.use(
    '/api-docs',
    apiReference({
      darkMode: true,
      theme: 'fastify',
      layout: 'classic',
      spec: {
        content: document,
      },
      defaultHttpClient: {
        targetKey: 'js',
        clientKey: 'fetch',
      },
      configuration: {
        showSidebar: true,
        hideDownloadButton: false,
        hideTestRequestButton: false,
        hideSchemas: false,
        hideModels: false,
        proxy:
          environment === 'development'
            ? `http://localhost:${port}`
            : undefined,
      },
      metaData: {
        title: 'Rabotka API Documentation',
        description:
          'API documentation for Rabotka backend service. Explore endpoints, request/response schemas, and test API calls directly from the documentation.',
      },
    } as Parameters<typeof apiReference>[0]),
  );

  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  logger.log(`🌍 Environment: ${environment}`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error('❌ Error starting application:', error);
  process.exit(1);
});
