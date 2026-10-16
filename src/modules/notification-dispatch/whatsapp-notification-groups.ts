import type { TemplateKey } from '../whatsapp/contracts';

export const WHATSAPP_NOTIFICATION_GROUPS = {
  job_recommendations: true,
  new_application: true,
  application_accepted: true,
  contact_unlocked: true,
  application_rejected: false,
  cancellations: false,
  offer_updates: false,
  mission_reminders: false,
  offer_expired: false,
  account_status: false,
  unlock_credit: false,
  claim_replies: false,
  mission_contract_pdf: false,
} as const satisfies Record<string, boolean>;

export type WhatsAppNotificationGroup =
  keyof typeof WHATSAPP_NOTIFICATION_GROUPS;

export const whatsAppNotificationKey = (group: WhatsAppNotificationGroup) =>
  `whatsapp.notify.${group}`;

export const TEMPLATE_NOTIFICATION_GROUP: Partial<
  Record<TemplateKey, WhatsAppNotificationGroup>
> = {
  jobRecommendation: 'job_recommendations',
  newApplication: 'new_application',
  applicationAccepted: 'application_accepted',
  applicationAcceptedUnlock: 'application_accepted',
  contactUnlocked: 'contact_unlocked',
  contactUnlockedRecommendation: 'contact_unlocked',
  applicationRejected: 'application_rejected',
  cancellation: 'cancellations',
  reminder24h: 'mission_reminders',
  reminderStart: 'mission_reminders',
  autoStarted: 'mission_reminders',
  statusCheck: 'mission_reminders',
  offerExpiredApplicant: 'offer_expired',
  offerExpiredEmployer: 'offer_expired',
  kycRejected: 'account_status',
  accountSuspended: 'account_status',
  unlockExpiredConversion: 'unlock_credit',
  claimCommented: 'claim_replies',
  missionContractDocument: 'mission_contract_pdf',
};
