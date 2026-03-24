import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { PrismaModule } from './common/services/prisma/prisma.module';
import { RedisModule } from './common/services/redis/redis.module';
import { QueueModule } from './common/services/queue/queue.module';
import { MailModule } from './modules/mail/mail.module';
import { TwilioService } from './common/services/twilio/twilio.service';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service';
import { ReminderProcessor } from './modules/bot/reminder/reminder.processor';
import { PrismaService } from './common/services/prisma/prisma.service';
import { QueueService } from './common/services/queue/queue.service';
import { REDIS_CONNECTION } from './common/services/redis/redis.constants';
import type Redis from 'ioredis';
import { PaymentProcessor } from './modules/payments/payment.processor';
import { getMailerTransportConfig } from './modules/mail/mailer-transport.config';

/**
 * Worker module for the queue worker process.
 *
 * Providers are registered directly (not through their full modules) to avoid
 * pulling in the full application module graph which has complex circular
 * dependencies (BotModule ↔ PaymentsModule ↔ SystemConfigModule ↔ AuthModule ↔
 * WhatsAppModule ↔ ConversationModule) that deadlock NestJS module compilation
 * in the worker context.
 *
 * Use RUN_REMINDER_WORKER=false for email-only mode. Default: reminders enabled.
 */
@Module({
  imports: [ConfigModule],
})
export class WorkerModule {
  static forRoot(): DynamicModule {
    const enableReminders = process.env.RUN_REMINDER_WORKER !== 'false';

    const coreImports = [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: ['.env.local', '.env'],
        cache: true,
        expandVariables: true,
      }),
      RedisModule.forRoot(),
      QueueModule.forRoot(),
      MailerModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => getMailerTransportConfig(config),
      }),
      PrismaModule,
      MailModule,
    ];

    const reminderProviders = enableReminders
      ? [
          {
            provide: TwilioService,
            useFactory: (config: ConfigService) => new TwilioService(config),
            inject: [ConfigService],
          },
          WhatsAppService,
          {
            provide: ReminderProcessor,
            useFactory: (
              prisma: unknown,
              whatsApp: WhatsAppService,
              queue: unknown,
              redis: Redis,
            ) =>
              new ReminderProcessor(
                prisma as never,
                whatsApp,
                queue as never,
                redis,
              ),
            inject: [
              PrismaService,
              WhatsAppService,
              QueueService,
              REDIS_CONNECTION,
            ],
          },
        ]
      : [];

    return {
      module: WorkerModule,
      imports: coreImports,
      providers: [...reminderProviders, PaymentProcessor],
    };
  }
}
