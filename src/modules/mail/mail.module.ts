import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';
import { LayoutService } from './layout.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
  controllers: [],
  providers: [MailService, MailProcessor, LayoutService],
  exports: [MailService, LayoutService],
})
export class MailModule {}
