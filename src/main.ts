import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port: number = configService.get('PORT', 3000);
  const environment = configService.get('NODE_ENV', 'development');

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
      theme: 'deepSpace',
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
    } as any),
  );

  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}`);
  logger.log(`📚 API Documentation: http://localhost:${port}/api-docs`);
  logger.log(`🌍 Environment: ${environment}`);
}
bootstrap();
