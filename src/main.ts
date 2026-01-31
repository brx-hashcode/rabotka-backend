import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
  const configService = app.get(ConfigService);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const port: number = configService.get<number>('PORT', 3000);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const environment: string = configService.get<string>(
    'NODE_ENV',
    'development',
  );

  app.setGlobalPrefix('api/v1');

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
