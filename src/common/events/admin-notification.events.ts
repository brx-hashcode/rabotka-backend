export enum AdminNotificationEvent {
  // Profile
  PROFILE_CREATED = 'admin.notification.profile.created',
  PROFILE_UPDATED = 'admin.notification.profile.updated',
  PROFILE_STATUS_CHANGED = 'admin.notification.profile.status_changed',
  PROFILE_KYC_VERIFIED = 'admin.notification.profile.kyc_verified',

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
}

export type AdminEntityType =
  | 'profile'
  | 'job-offer'
  | 'application'
  | 'claim'
  | 'event'
  | 'payment'
  | 'penalty';

export interface AdminNotificationPayload {
  event: AdminNotificationEvent;
  title: string;
  message: string;
  entityType: AdminEntityType;
  entityId: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
