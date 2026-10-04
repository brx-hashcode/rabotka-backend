export enum AdminNotificationEvent {
  // Profile
  PROFILE_CREATED = 'admin.notification.profile.created',
  PROFILE_UPDATED = 'admin.notification.profile.updated',
  PROFILE_STATUS_CHANGED = 'admin.notification.profile.status_changed',
  PROFILE_KYC_VERIFIED = 'admin.notification.profile.kyc_verified',
  /** Typed a support keyword to the WhatsApp bot — may want a human. */
  SUPPORT_REQUESTED = 'admin.notification.profile.support_requested',

  // Conversation (in-app chat)
  /** Moderation held a message back whole; it never reached the recipient. */
  CONVERSATION_MESSAGE_HELD = 'admin.notification.conversation.message_held',
  /** Contact details were masked inside a message that was still delivered. */
  CONVERSATION_CONTACT_MASKED = 'admin.notification.conversation.contact_masked',

  // Job Offer
  JOB_OFFER_CREATED = 'admin.notification.job_offer.created',
  JOB_OFFER_UPDATED = 'admin.notification.job_offer.updated',
  JOB_OFFER_STATUS_CHANGED = 'admin.notification.job_offer.status_changed',
  JOB_OFFER_DELETED = 'admin.notification.job_offer.deleted',

  // Application
  APPLICATION_CREATED = 'admin.notification.application.created',
  APPLICATION_ACCEPTED = 'admin.notification.application.accepted',
  APPLICATION_REJECTED = 'admin.notification.application.rejected',
  APPLICATION_CANCELLED = 'admin.notification.application.cancelled',
  APPLICATION_COMPLETED = 'admin.notification.application.completed',

  // Claim
  CLAIM_CREATED = 'admin.notification.claim.created',
  CLAIM_UPDATED = 'admin.notification.claim.updated',
  CLAIM_COMMENTED = 'admin.notification.claim.commented',

  // Event (calendar)
  EVENT_CREATED = 'admin.notification.event.created',
  EVENT_UPDATED = 'admin.notification.event.updated',

  // Payment
  PAYMENT_ACTIVATION = 'admin.notification.payment.activation',
  PAYMENT_JOB_POSTING = 'admin.notification.payment.job_posting',
  PAYMENT_PENALTY = 'admin.notification.payment.penalty',

  // Penalty
  PENALTY_CREATED = 'admin.notification.penalty.created',
  PENALTY_SOLVED = 'admin.notification.penalty.solved',
  PENALTY_UPDATED = 'admin.notification.penalty.updated',

  // Field agents
  /** A worker accepted an agent's invitation: an application now exists. */
  AGENT_PLACEMENT = 'admin.notification.agent.placement',
  /** An agent asked to be paid; it waits in Agent payouts. */
  AGENT_WITHDRAWAL_REQUESTED = 'admin.notification.agent.withdrawal_requested',
}

export type AdminEntityType =
  | 'profile'
  | 'job-offer'
  | 'application'
  | 'claim'
  | 'event'
  | 'payment'
  | 'penalty'
  | 'conversation'
  | 'agent'
  /** An application a field agent brought in; entityId is the application. */
  | 'agent-placement'
  | 'agent-withdrawal';

export interface AdminNotificationPayload {
  event: AdminNotificationEvent;
  title: string;
  message: string;
  entityType: AdminEntityType;
  entityId: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  /**
   * Suppresses a repeat while an earlier alert is still unread.
   *
   * For events one person can fire in a burst — a support keyword typed three
   * times, a string of held messages in one conversation. If an UNREAD alert
   * with the same event and entity was created within this many milliseconds,
   * the new one is neither stored nor pushed. Once an admin has read it, the
   * next occurrence alerts again.
   */
  dedupeWindowMs?: number;
}
