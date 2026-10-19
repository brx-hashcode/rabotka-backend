import { AdminCacheService } from './common/services/cache/admin-cache.service';
import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateWhatsappEnv } from './modules/whatsapp/whatsapp.config';
import { TwilioProvider } from './modules/whatsapp/providers/twilio/twilio.provider';
import { whatsappProviderFactory } from './modules/whatsapp/whatsapp-provider.factory';
import {
  WHATSAPP_PROVIDER,
  type WhatsappProvider,
} from './modules/whatsapp/contracts';
import { MailerModule } from '@nestjs-modules/mailer';
import { PrismaModule } from './common/services/prisma/prisma.module';
import { RedisModule } from './common/services/redis/redis.module';
import { IdempotencyModule } from './common/services/idempotency/idempotency.module';
import { IdempotencyService } from './common/services/idempotency/idempotency.service';
import { QueueModule } from './common/services/queue/queue.module';
import { MailModule } from './modules/mail/mail.module';
import { TwilioService } from './common/services/twilio/twilio.service';
import { SendTimingService } from './modules/whatsapp/telemetry/send-timing.service';
import { WhatsAppService } from './modules/whatsapp/whatsapp.service';
import { WhatsappMessageLogService } from './modules/whatsapp/logging/whatsapp-message-log.service';
import { ReminderProcessor } from './modules/bot/reminder/reminder.processor';
import { PrismaService } from './common/services/prisma/prisma.service';
import { QueueService } from './common/services/queue/queue.service';
import { REDIS_CONNECTION } from './common/services/redis/redis.constants';
import { WhatsAppLoginLinkService } from './modules/auth/whatsapp-login-link.service';
import type Redis from 'ioredis';
import { PaymentProcessor } from './modules/payments/payment.processor';
import { WhatsAppOutboundProcessor } from './modules/whatsapp/whatsapp-outbound.processor';
import { getMailerTransportConfig } from './modules/mail/mailer-transport.config';
import { WalletService } from './modules/wallet/wallet.service';
import { SystemConfigService } from './modules/system-config/system-config.service';
import { LayoutService } from './modules/mail/layout.service';
import { MailService } from './modules/mail/mail.service';
import { InvoiceService } from './modules/invoice/invoice.service';
import { PenaltyNotificationProcessor } from './modules/penalty/penalty-notification.processor';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProfileChatProcessor } from './modules/profile-chat/profile-chat.processor';
import { BroadcastProcessor } from './modules/broadcast/broadcast.processor';
import { BotPauseService } from './modules/bot/services/bot-pause.service';
import { NotificationDispatcher } from './modules/notification-dispatch/notification-dispatcher.service';
import { ProfileNotificationService } from './modules/profile-notification/profile-notification.service';
import { ProfileWebPushService } from './modules/profile-notification/profile-web-push.service';
import { WebPushService } from './common/services/web-push/web-push.service';

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
        // Same gate as the API process: the worker sends the bulk of the
        // outbound traffic, so it must not boot on a blank credential either.
        validate: validateWhatsappEnv,
      }),
      RedisModule.forRoot(),
      IdempotencyModule,
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
        provide: LayoutService,
        useFactory: (systemConfig: SystemConfigService) =>
          new LayoutService(systemConfig),
        inject: [SystemConfigService],
      },
      {
        provide: SendTimingService,
        useFactory: (redis: Redis) => new SendTimingService(redis),
        inject: [REDIS_CONNECTION],
      },
      {
        provide: TwilioService,
        useFactory: (config: ConfigService, sendTiming: SendTimingService) =>
          new TwilioService(config, sendTiming),
        inject: [ConfigService, SendTimingService],
      },
      {
        provide: WalletService,
        useFactory: (prisma: PrismaService) =>
          new WalletService(
            prisma,
            null as unknown as SystemConfigService,
            null as unknown as InvoiceService,
            // Admin list caching is never exercised in the worker process.
            null as unknown as AdminCacheService,
          ),
        inject: [PrismaService],
      },
      {
        // The worker builds its graph by hand, so the provider token has to be
        // registered here too — WhatsAppService injects it, not TwilioService.
        provide: TwilioProvider,
        useFactory: (twilio: TwilioService) => new TwilioProvider(twilio),
        inject: [TwilioService],
      },
      whatsappProviderFactory,
      WhatsappMessageLogService,
      {
        provide: WhatsAppService,
        useFactory: (
          redis: Redis,
          prisma: PrismaService,
          provider: WhatsappProvider,
          config: ConfigService,
          wallet: WalletService,
          idempotency: IdempotencyService,
          messageLog: WhatsappMessageLogService,
        ) =>
          new WhatsAppService(
            redis,
            prisma,
            provider,
            config,
            wallet,
            idempotency,
            messageLog,
          ),
        inject: [
          REDIS_CONNECTION,
          PrismaService,
          WHATSAPP_PROVIDER,
          ConfigService,
          WalletService,
          IdempotencyService,
          WhatsappMessageLogService,
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

    const penaltyProvider = {
      provide: PenaltyNotificationProcessor,
      useFactory: (
        prisma: PrismaService,
        queue: QueueService,
        whatsApp: WhatsAppService,
        loginLink: WhatsAppLoginLinkService,
        systemConfig: SystemConfigService,
      ) =>
        new PenaltyNotificationProcessor(
          prisma,
          queue,
          whatsApp,
          loginLink,
          systemConfig,
        ),
      inject: [
        PrismaService,
        QueueService,
        WhatsAppService,
        WhatsAppLoginLinkService,
        SystemConfigService,
      ],
    };

    /**
     * Broadcasts, assembled by hand rather than by importing BroadcastModule.
     *
     * That module pulls AuthModule for its controller's guard, which drags in
     * PaymentsModule and the rest of the API graph — none of which the worker
     * registers, so importing it crashed this process at boot with an
     * unresolved EventEmitter. The fan-out needs six collaborators and no
     * controller, so it is built the same way ReminderProcessor is.
     */
    const broadcastProvider = {
      provide: BroadcastProcessor,
      useFactory: (
        prisma: PrismaService,
        queue: QueueService,
        whatsApp: WhatsAppService,
        loginLink: WhatsAppLoginLinkService,
        systemConfig: SystemConfigService,
        idempotency: IdempotencyService,
        mail: MailService,
        config: ConfigService,
      ) => {
        // The worker builds its providers by hand, so a new dependency on the
        // dispatcher has to be supplied here too. It is a per-profile bot
        // pause, and the worker is exactly where it matters: this is the
        // process that fires the scheduled reminders an admin mid-handover
        // must not be interrupted by.
        const dispatcher = new NotificationDispatcher(
          whatsApp,
          loginLink,
          systemConfig,
          new BotPauseService(prisma),
        );
        // The gateway holds no server outside the HTTP app, so its emit is
        // already a no-op there (see `emitNew`). A stub says that outright
        // instead of relying on a null check three files away.
        const gateway = { emitNew: () => undefined } as never;
        const inApp = new ProfileNotificationService(
          prisma,
          idempotency,
          systemConfig,
          gateway,
          new EventEmitter2(),
          // A broadcast's phone notifications go out from here, the process
          // that writes its rows.
          new ProfileWebPushService(prisma, new WebPushService(prisma, config)),
        );
        return new BroadcastProcessor(
          prisma,
          queue,
          dispatcher,
          inApp,
          mail,
          new LayoutService(systemConfig),
        );
      },
      inject: [
        PrismaService,
        QueueService,
        WhatsAppService,
        WhatsAppLoginLinkService,
        SystemConfigService,
        IdempotencyService,
        MailService,
        ConfigService,
      ],
    };

    /**
     * The unread-message nudge.
     *
     * Hand-wired for the same reason as the broadcast one above: importing
     * ProfileChatModule would drag AuthModule in behind it and crash this
     * process at boot. Five collaborators, no controller, no gateway — the
     * nudge never touches the socket.
     */
    const messagingNudgeProvider = {
      provide: ProfileChatProcessor,
      useFactory: (
        queue: QueueService,
        prisma: PrismaService,
        systemConfig: SystemConfigService,
        whatsApp: WhatsAppService,
        loginLink: WhatsAppLoginLinkService,
      ) =>
        new ProfileChatProcessor(
          queue,
          prisma,
          systemConfig,
          new NotificationDispatcher(
            whatsApp,
            loginLink,
            systemConfig,
            new BotPauseService(prisma),
          ),
          whatsApp,
        ),
      inject: [
        QueueService,
        PrismaService,
        SystemConfigService,
        WhatsAppService,
        WhatsAppLoginLinkService,
      ],
    };

    return {
      module: WorkerModule,
      imports: coreImports,
      providers: [
        ...whatsAppProviders,
        ...reminderProviders,
        penaltyProvider,
        broadcastProvider,
        messagingNudgeProvider,
        PaymentProcessor,
        WhatsAppLoginLinkService,
        {
          provide: WhatsAppOutboundProcessor,
          useFactory: (
            whatsApp: WhatsAppService,
            loginLink: WhatsAppLoginLinkService,
            config: ConfigService,
          ) => new WhatsAppOutboundProcessor(whatsApp, loginLink, config),
          inject: [WhatsAppService, WhatsAppLoginLinkService, ConfigService],
        },
      ],
    };
  }
}
