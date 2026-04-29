import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueService } from './queue.service';

export const EMAIL_QUEUE = 'email-queue';
export const WHATSAPP_REMINDERS_QUEUE = 'whatsapp-reminders-queue';
export const PAYMENT_QUEUE = 'payment-queue';
export const WHATSAPP_OUTBOUND_QUEUE = 'whatsapp-outbound-queue';
export const WHATSAPP_OUTBOUND_DLQ = 'whatsapp-outbound-dlq';
export const PENALTY_NOTIFICATIONS_QUEUE = 'penalty-notifications-queue';
export const VECTOR_INDEX_QUEUE = 'vector-index-queue';
export const INTEREST_RECLUSTER_QUEUE = 'interest-recluster-queue';
export const POLL_PAYMENT_STATUS_QUEUE = 'poll-payment-status-queue';

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
