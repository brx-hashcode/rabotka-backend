import { Logger, ValidationPipe } from '@nestjs/common';
import { I18nMiddleware } from 'nestjs-i18n';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiDocsPage } from './common/docs/api-docs-page';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { initVovaTracing } from './modules/rag/observability/tracing';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import {
  originCheck,
  parseAllowOrigins,
} from './modules/csrf/origin-check.middleware';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { securityHeaders } from './common/middleware/security-headers.middleware';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Before the app exists, so the OpenTelemetry context is in place by the
  // first VoVa turn. A no-op without LANGFUSE_* keys; never throws.
  await initVovaTracing();

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
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

  const parsedOrigins = parseAllowOrigins(allowOrigins);
  const origins = parsedOrigins.length
    ? parsedOrigins
    : ['http://localhost:3000'];

  app.enableCors({
    origin: origins,
    credentials: true,
  });

  const httpAdapter = app.getHttpAdapter().getInstance();
  httpAdapter.set('trust proxy', 1);
  // No reason to tell every caller which framework answers.
  httpAdapter.disable('x-powered-by');

  const isProduction = environment === 'production';

  // First, so the headers are on every response — static files, the docs page
  // and the JSON 403 the origin check writes below included.
  app.use(securityHeaders(isProduction));

  // The interactive API reference lists every route, parameter and schema, and
  // can call them. That is a map of the API for whoever finds it, so production
  // serves it only when asked to with API_DOCS_ENABLED=true; everywhere else it
  // is on, as it has always been.
  const docsEnabled =
    !isProduction || configService.get<string>('API_DOCS_ENABLED') === 'true';

  httpAdapter.get('/', (_, res) => {
    if (docsEnabled) {
      res.redirect('/api-docs');
      return;
    }
    res.status(404).json({ statusCode: 404, message: 'Not Found' });
  });

  httpAdapter.use(
    express.static(path.join(process.cwd(), 'public'), { index: false }),
  );

  // The two OIDC discovery documents are excluded alongside `metrics` because
  // RFC 8414 fixes their paths relative to the issuer: every OIDC client
  // library builds them by appending to the issuer URL, so serving them under
  // `/api/v1` would make "Login with Rabotka" undiscoverable by every
  // off-the-shelf client — which is the entire compatibility the feature buys.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      'metrics',
      '.well-known/openid-configuration',
      '.well-known/jwks.json',
    ],
  });

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

  // Before everything that might record an interaction, so a ranked feed and
  // the taps that follow it share one correlation id.
  app.use(requestIdMiddleware);
  app.use(I18nMiddleware);
  app.use(cookieParser());
  // CSRF: refuse a state-changing request from an origin that is not ours —
  // the same list CORS allows, plus the API's own host for the docs page. See
  // origin-check.middleware.ts for why this replaced the CSRF token.
  const appBaseUrl = configService.get<string>('APP_BASE_URL');
  app.use(
    originCheck([
      ...origins,
      ...(appBaseUrl ? [appBaseUrl] : [`http://localhost:${port}`]),
    ]),
  );

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
    .addServer(
      configService.get<string>('APP_BASE_URL') ?? `http://localhost:${port}`,
      configService.get<string>('APP_BASE_URL')
        ? 'Public Server'
        : 'Local Development Server',
    )
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
    // Every operation, so a token entered once in the reference's
    // Authentication panel is sent on all of them. Public routes simply
    // ignore it; the docs page also captures login tokens by itself.
    .addSecurityRequirements('bearer')
    .build();

  if (docsEnabled) {
    const document = SwaggerModule.createDocument(app, config);

    app.use(
      '/api-docs',
      // Our own page around Scalar: it adds the session script that fills in
      // the bearer token by itself — see
      // common/docs/docs-session.script.ts.
      apiDocsPage(
        {
          defaultOpenAllTags: true,
          hideClientButton: false,

          showSidebar: true,
          showDeveloperTools:
            environment === 'development' ? 'localhost' : false,
          showToolbar: environment === 'development' ? 'localhost' : false,
          operationTitleSource: 'summary',
          theme: 'moon',
          persistAuth: false,
          // The reference page must not report usage to its vendor.
          telemetry: false,
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
        } as Parameters<typeof apiDocsPage>[0],
        '/api/v1',
      ),
    );
  }

  // Back Socket.IO with Redis so rooms/emits work across API instances.
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis(configService);
  app.useWebSocketAdapter(redisIoAdapter);

  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}`);
  if (docsEnabled) {
    logger.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  }
  logger.log(`🌍 Environment: ${environment}`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error('❌ Error starting application:', error);
  process.exit(1);
});
