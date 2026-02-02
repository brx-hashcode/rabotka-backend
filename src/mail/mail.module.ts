import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MailerModule } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/dist/adapters/handlebars.adapter';
import { BullModule } from '@nestjs/bullmq';
import * as path from 'node:path';
import { MailController } from './mail.controller.js';
import { MailProcessor } from './mail.processor.js';
import { MailService } from './mail.service.js';

/** Only the process that sets RUN_QUEUE_WORKER=true runs the mail queue worker. */
const registerProcessor = process.env.RUN_QUEUE_WORKER === 'true';

@Module({
  imports: [
    MailerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('SMTP_HOST', 'localhost');
        const port = config.get<number>('SMTP_PORT', 1025);
        const secure = config.get<string>('SMTP_SECURE') === 'true';
        const user = config.get<string>('SMTP_USER');
        const pass = config.get<string>('SMTP_PASSWORD');
        return {
          transport: {
            host,
            port,
            secure,
            ...(user && pass ? { auth: { user, pass } } : {}),
          },
          defaults: {
            from: config.get<string>('MAIL_FROM') ?? 'noreply@localhost',
          },
          template: {
            dir: path.join(__dirname, 'templates'),
            adapter: new HandlebarsAdapter(),
            options: { strict: true },
          },
        };
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
  controllers: [MailController],
  providers: [MailService, ...(registerProcessor ? [MailProcessor] : [])],
  exports: [MailService],
})
export class MailModule {}
