import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueService } from './queue.service';

export const EMAIL_QUEUE = 'email-queue';
export const WHATSAPP_REMINDERS_QUEUE = 'whatsapp-reminders-queue';
export const PAYMENT_QUEUE = 'payment-queue';
export const WHATSAPP_OUTBOUND_QUEUE = 'whatsapp-outbound-queue';
export const WHATSAPP_OUTBOUND_DLQ = 'whatsapp-outbound-dlq';

@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      imports: [ConfigModule],
      providers: [QueueService],
      exports: [QueueService],
    };
  }
}
