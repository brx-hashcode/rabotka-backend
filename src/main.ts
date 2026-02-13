import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { CSRF_UTILITIES } from './modules/csrf/csrf.constants';
import { csrfVisitorMiddleware } from './modules/csrf/csrf-visitor.middleware';

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

  const httpAdapter = app.getHttpAdapter().getInstance();

  httpAdapter.get('/', (_, res) => {
    res.redirect('/api-docs');
  });

  httpAdapter.use(
    express.static(path.join(process.cwd(), 'public'), { index: false }),
  );

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.use(cookieParser());
  app.use(csrfVisitorMiddleware);

  const csrfUtilities = app.get(CSRF_UTILITIES);
  app.use(csrfUtilities.doubleCsrfProtection);

  app.useGlobalInterceptors(new LoggingInterceptor());

  const config = new DocumentBuilder()
    .setTitle('Rabotka Backend API - REST Service Documentation')
    .setDescription(
      'Comprehensive REST API documentation for the Rabotka backend service. ' +
        'This API provides endpoints for user authentication, job management, application processing, ' +
        'and workforce analytics. All endpoints require JWT bearer token authentication except for public endpoints. ' +
        'For integration support, contact api-support@rabotka.com',
    )
    .setVersion('1.0.0')
    .addServer(`http://localhost:${port}`, 'Local Development Server')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);

  app.use(
    '/api-docs',
    apiReference({
      defaultOpenAllTags: true,
      additionalHeaders: [
        {
          name: 'X-CSRF-TOKEN',
          description: 'CSRF token',
          required: true,
        },
      ],
      hideClientButton: false,

      showSidebar: true,
      showDeveloperTools: environment === 'development' ? 'localhost' : false,
      showToolbar: environment === 'development' ? 'localhost' : false,
      operationTitleSource: 'summary',
      theme: 'moon',
      persistAuth: false,
      telemetry: true,
      layout: 'classic',
      isEditable: false,
      isLoading: false,
      hideModels: false,
      documentDownloadType: 'both',
      hideTestRequestButton: false,
      hideSearch: false,
      showOperationId: false,
      hideDarkModeToggle: false,
      withDefaultFonts: true,
      expandAllModelSections: false,
      expandAllResponses: false,
      orderSchemaPropertiesBy: 'alpha',
      orderRequiredPropertiesFirst: true,
      _integration: 'nestjs',
      darkMode: true,
      spec: {
        content: document,
      },
      defaultHttpClient: {
        targetKey: 'js',
        clientKey: 'fetch',
      },
      configuration: {
        proxy:
          environment === 'development'
            ? `http://localhost:${port}`
            : undefined,
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
