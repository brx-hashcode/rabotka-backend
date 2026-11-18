export enum AdminNotificationEvent {
  // Profile
  PROFILE_CREATED = 'admin.notification.profile.created',
  PROFILE_UPDATED = 'admin.notification.profile.updated',
  PROFILE_STATUS_CHANGED = 'admin.notification.profile.status_changed',
  PROFILE_KYC_VERIFIED = 'admin.notification.profile.kyc_verified',
  /** A person sent their identity documents (at sign-up or later): a KYC to review. */
  PROFILE_KYC_SUBMITTED = 'admin.notification.profile.kyc_submitted',
  /** An organisation signed up, or resubmitted its papers: to review. */
  ORGANISATION_REVIEW_REQUESTED = 'admin.notification.profile.organisation_review_requested',
  /** The platform suspended an account by itself (repeated cancellations…). */
  PROFILE_AUTO_SUSPENDED = 'admin.notification.profile.auto_suspended',
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
  /** A client commented on their claim. */
  CLAIM_COMMENTED = 'admin.notification.claim.commented',
  /** An admin commented on a claim: their own action, never on the bell. */
  /** An admin opened a claim for someone: their own action, never on the bell. */
  CLAIM_CREATED_BY_ADMIN = 'admin.notification.claim.created_by_admin',
  CLAIM_COMMENTED_BY_ADMIN = 'admin.notification.claim.commented_by_admin',

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

  // Rabotka Business
  /** A company asked for a demo from the business site. */
  DEMO_REQUEST_CREATED = 'admin.notification.demo_request.created',
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
  | 'agent-withdrawal'
  /** A « Demander une démo » request; entityId is the DemoRequest. */
  | 'demo-request';

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

/**
 * The events the admin bell shows: only those someone has to act on.
 *
 * Every event is still emitted (other listeners use them: the KYC reviewer
 * emails, the demo-request emails); the bell just stops storing and pushing
 * routine activity and an admin's own actions, which the dashboards and lists
 * already show. It used to ring for every profile created, every KYC an admin
 * had just verified, every profile edit, every application.
 */
export const ADMIN_BELL_EVENTS: ReadonlySet<string> = new Set<string>([
  AdminNotificationEvent.PROFILE_KYC_SUBMITTED,
  AdminNotificationEvent.ORGANISATION_REVIEW_REQUESTED,
  AdminNotificationEvent.PROFILE_AUTO_SUSPENDED,
  AdminNotificationEvent.SUPPORT_REQUESTED,
  AdminNotificationEvent.CONVERSATION_MESSAGE_HELD,
  AdminNotificationEvent.CLAIM_CREATED,
  AdminNotificationEvent.CLAIM_COMMENTED,
  // Only emitted as « subscription paid without a period: grant it by hand ».
  AdminNotificationEvent.PAYMENT_ACTIVATION,
  AdminNotificationEvent.AGENT_WITHDRAWAL_REQUESTED,
  AdminNotificationEvent.DEMO_REQUEST_CREATED,
]);

/** Whether an alert belongs on the admin bell. Unknown or missing: no. */
export function isBellEvent(event: string | null | undefined): boolean {
  return !!event && ADMIN_BELL_EVENTS.has(event);
}
