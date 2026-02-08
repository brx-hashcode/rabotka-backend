import {
  ArcjetGuard,
  ArcjetModule,
  detectBot,
  fixedWindow,
  shield,
} from '@arcjet/nest';
import { Module } from '@nestjs/common';
import { createArcjetLoggerAdapter } from './common/utils/arcjet-logger.adapter.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { MailerModule } from '@nestjs-modules/mailer';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaModule } from './common/services/prisma/prisma.module';
import { RedisModule } from './common/services/redis/redis.module';
import { QueueModule } from './common/services/queue/queue.module';
import { HealthModule } from './modules/health/health.module';
import { CsrfModule } from './modules/csrf/csrf.module';
import { getMailerTransportConfig } from './modules/mail/mailer-transport.config.js';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfileModule } from './modules/profile/profile.module';
import { UserModule } from './modules/user/user.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { FileModule } from './modules/file/file.module';
import { LogModule } from './modules/log/log.module';
import { StorageModule } from './common/services/storage/storage.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { I18nExceptionFilter } from './common/filters/i18n-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
      expandVariables: true,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL', 60000),
            limit: config.get<number>('THROTTLE_LIMIT', 100),
          },
        ],
      }),
    }),
    ArcjetModule.forRootAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        key: config.get<string>('ARCJET_KEY') ?? '',
        log: createArcjetLoggerAdapter(),
        rules: [
          shield({ mode: 'LIVE' }),
          detectBot({
            mode: 'LIVE',
            allow: ['CATEGORY:SEARCH_ENGINE'],
          }),
          fixedWindow({
            mode: 'LIVE',
            window: '60s',
            max: 100,
          }),
        ],
      }),
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      fallbacks: {
        'en-*': 'en',
      },
      loaderOptions: {
        path: (() => {
          const distI18n = path.join(process.cwd(), 'dist', 'i18n');
          const srcI18n = path.join(process.cwd(), 'src', 'i18n');
          return fs.existsSync(distI18n) ? distI18n : srcI18n;
        })(),
        watch: true,
      },
      resolvers: [
        new AcceptLanguageResolver({
          matchType: 'strict',
        }),
      ],
    }),
    PrismaModule,
    RedisModule.forRoot(),
    QueueModule.forRoot(),
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => getMailerTransportConfig(config),
    }),
    HealthModule,
    CsrfModule,
    MailModule,
    AuthModule,
    ProfileModule,
    UserModule,
    ConversationModule,
    StorageModule,
    FileModule,
    LogModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ArcjetGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: I18nExceptionFilter },
  ],
})
export class AppModule {}
