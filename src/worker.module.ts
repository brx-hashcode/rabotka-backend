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
import { WhatsAppOutboundProcessor } from './modules/whatsapp/whatsapp-outbound.processor';
import { getMailerTransportConfig } from './modules/mail/mailer-transport.config';
import { WalletService } from './modules/wallet/wallet.service';
import { SystemConfigService } from './modules/system-config/system-config.service';
import { InvoiceService } from './modules/invoice/invoice.service';

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

    const systemConfigProvider = {
      provide: SystemConfigService,
      useFactory: (prisma: PrismaService, redis: Redis) =>
        new SystemConfigService(prisma, redis),
      inject: [PrismaService, REDIS_CONNECTION],
    };

    // WhatsApp outbound always needed (not just for reminders).
    // TwilioService needs SystemConfigService so twilio.whatsapp_from (and optional DB credentials) load like the API.
    const whatsAppProviders = [
      systemConfigProvider,
      {
        provide: TwilioService,
        useFactory: (
          config: ConfigService,
          systemConfig: SystemConfigService,
        ) => new TwilioService(config, systemConfig),
        inject: [ConfigService, SystemConfigService],
      },
      {
        provide: WalletService,
        useFactory: (prisma: PrismaService) =>
          new WalletService(
            prisma,
            null as unknown as SystemConfigService,
            null as unknown as InvoiceService,
          ),
        inject: [PrismaService],
      },
      {
        provide: WhatsAppService,
        useFactory: (
          redis: Redis,
          prisma: PrismaService,
          twilio: TwilioService,
          config: ConfigService,
          wallet: WalletService,
        ) => new WhatsAppService(redis, prisma, twilio, config, wallet),
        inject: [
          REDIS_CONNECTION,
          PrismaService,
          TwilioService,
          ConfigService,
          WalletService,
        ],
      },
    ];

    const reminderProviders = enableReminders
      ? [
          {
            provide: ReminderProcessor,
            useFactory: (
              prisma: unknown,
              whatsApp: WhatsAppService,
              queue: unknown,
              redis: Redis,
              systemConfig: SystemConfigService,
            ) => {
              // Minimal stubs for services only needed in full bot context
              const contactUnlockStub = {
                expirePendingAttemptsForJob: async () => [],
              } as never;
              const botNotificationStub = {
                sendContactUnlockCreditConversionNotification: async () => {},
              } as never;
              return new ReminderProcessor(
                prisma as never,
                whatsApp,
                queue as never,
                redis,
                systemConfig,
                contactUnlockStub,
                botNotificationStub,
              );
            },
            inject: [
              PrismaService,
              WhatsAppService,
              QueueService,
              REDIS_CONNECTION,
              SystemConfigService,
            ],
          },
        ]
      : [];

    return {
      module: WorkerModule,
      imports: coreImports,
      providers: [
        ...whatsAppProviders,
        ...reminderProviders,
        PaymentProcessor,
        {
          provide: WhatsAppOutboundProcessor,
          useFactory: (whatsApp: WhatsAppService) =>
            new WhatsAppOutboundProcessor(whatsApp),
          inject: [WhatsAppService],
        },
      ],
    };
  }
}
