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
export const CONTACT_UNLOCK_QUEUE = 'contact-unlock-queue';
export const POLL_PAYMENT_STATUS_QUEUE = 'poll-payment-status-queue';
export const WHATSAPP_INBOUND_QUEUE = 'whatsapp-inbound-queue';
export const USER_FEATURE_QUEUE = 'user-feature-queue';
export const JOB_NOTIFICATION_QUEUE = 'job-notification-queue';
export const WHATSAPP_LOG_RETENTION_QUEUE = 'whatsapp-log-retention-queue';
export const IDENTITY_CHECK_QUEUE = 'identity-check-queue';
export const PARTNER_ACTIVITY_QUEUE = 'partner-activity-queue';
/** Admin broadcasts: one job per page of frozen recipient rows. */
export const BROADCAST_QUEUE = 'broadcast-queue';
/**
 * "You have an unread message" — one DELAYED job per conversation and
 * recipient, not one per message.
 *
 * The delay is the whole mechanism: a back-and-forth produces one nudge rather
 * than a dozen, and the job re-checks at fire time whether anything is still
 * unread. There is no cancel API on QueueService, and re-checking is the
 * sturdier answer anyway — it survives the race where somebody reads while the
 * job is already running.
 */
export const MESSAGING_NUDGE_QUEUE = 'messaging-nudge-queue';
/** Field agents' commissions: one repeatable sweep that decides and releases them. */
export const AGENT_COMMISSION_QUEUE = 'agent-commission-queue';
export const BUSINESS_SUBSCRIPTION_QUEUE = 'business-subscription-queue';
/** Business CV screening: one job per CV, plus the repeatable stuck/retention sweep. */
export const CV_SCREENING_QUEUE = 'cv-screening-queue';
export const CV_SCREENING_SWEEP_QUEUE = 'cv-screening-sweep-queue';
/** Interview reminders, the day before. */
export const INTERVIEW_QUEUE = 'interview-queue';

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
