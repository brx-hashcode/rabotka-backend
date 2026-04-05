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
import { I18nModule, AcceptLanguageResolver, QueryResolver } from 'nestjs-i18n';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaModule } from './common/services/prisma/prisma.module';
import { TwilioModule } from './common/services/twilio/twilio.module';
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
import { JobOfferModule } from './modules/job-offer/job-offer.module';
import { ApplicationModule } from './modules/application/application.module';
import { PenaltyModule } from './modules/penalty/penalty.module';
import { PaymentRequestModule } from './modules/payment-request/payment-request.module';
import { FileModule } from './modules/file/file.module';
import { LogModule } from './modules/log/log.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { ReminderModule } from './modules/bot/reminder/reminder.module';
import { PaymentsModule } from './modules/payments/payment.module';
import { KycModule } from './modules/kyc/kyc.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { QdrantModule } from './modules/qdrant/qdrant.module';
import { ClaimModule } from './modules/claim/claim.module';
import { DocumentModule } from './modules/document/document.module';
import { EventModule } from './modules/event/event.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WsNotificationsModule } from './modules/ws-notifications/ws-notifications.module';
import { ContactUnlockModule } from './modules/contact-unlock/contact-unlock.module';
import { StorageModule } from './common/services/storage/storage.module';
import { ImageWatermarkModule } from './common/services/image-watermark/image-watermark.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

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
      fallbackLanguage: 'fr',
      loaderOptions: {
        path: (() => {
          const srcI18n = path.join(process.cwd(), 'src', 'i18n');
          const distI18n = path.join(process.cwd(), 'dist', 'i18n');
          return fs.existsSync(srcI18n) ? srcI18n : distI18n;
        })(),
        watch: true,
      },
      resolvers: [
        { use: QueryResolver, options: ['lang'] },
        AcceptLanguageResolver,
      ],
    }),
    PrismaModule,
    TwilioModule,
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
    WhatsAppModule,
    ReminderModule,
    AuthModule,
    ProfileModule,
    UserModule,
    ConversationModule,
    JobOfferModule,
    ApplicationModule,
    PenaltyModule,
    PaymentRequestModule,
    SystemConfigModule,
    StorageModule,
    ImageWatermarkModule,
    FileModule,
    LogModule,
    WalletModule,
    ClaimModule,
    DocumentModule,
    EventModule,
    DashboardModule,
    PaymentsModule,
    KycModule,
    QdrantModule,
    EventEmitterModule.forRoot({ wildcard: true }),
    ContactUnlockModule,
    WsNotificationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ArcjetGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
