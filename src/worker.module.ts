import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { PrismaModule } from './common/services/prisma/prisma.module';
import { RedisModule } from './common/services/redis/redis.module';
import { QueueModule } from './common/services/queue/queue.module';
import { TwilioModule } from './common/services/twilio/twilio.module';
import { MailModule } from './modules/mail/mail.module';
import { ReminderModule } from './modules/bot/reminder/reminder.module';
import { PaymentsModule } from './modules/payments/payment.module';
import { getMailerTransportConfig } from './modules/mail/mailer-transport.config';

const baseImports = [
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
  PaymentsModule,
];

/**
 * Worker module for the queue worker process.
 * Use WorkerModule.forRoot() so reminders are optional: set RUN_REMINDER_WORKER=false
 * for email-only mode (no Twilio/WhatsApp/ReminderModule). Default: reminders enabled.
 */
@Module({
  imports: baseImports,
})
export class WorkerModule {
  static forRoot(): DynamicModule {
    const enableReminders = process.env.RUN_REMINDER_WORKER !== 'false';
    const imports = enableReminders
      ? [...baseImports, TwilioModule, ReminderModule]
      : baseImports;
    return {
      module: WorkerModule,
      imports,
    };
  }
}
