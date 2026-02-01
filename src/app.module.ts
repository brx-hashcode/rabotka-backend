import {
    ArcjetGuard,
    ArcjetModule,
    detectBot,
    fixedWindow,
    shield,
    validateEmail,
} from '@arcjet/nest';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { I18nModule, AcceptLanguageResolver } from 'nestjs-i18n';
import * as path from 'node:path';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { CsrfModule } from './csrf/csrf.module';
import { MailModule } from './mail/mail.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

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
        rules: [
          shield({ mode: 'LIVE' }),
          detectBot({
            mode: 'LIVE',
            allow: ['CATEGORY:SEARCH_ENGINE'],
          }),
          fixedWindow({
            mode: 'LIVE',
            window: '60s',
            max: 2,
          }),
          validateEmail({
            mode: 'LIVE',
            deny: ['DISPOSABLE', 'INVALID', 'NO_MX_RECORDS'],
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
        path: path.join(__dirname, '../i18n/'),
        watch: true,
      },
      resolvers: [
        new AcceptLanguageResolver({
          matchType: 'strict',
        }),
      ],
    }),
    PrismaModule,
    HealthModule,
    CsrfModule,
    MailModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ArcjetGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
