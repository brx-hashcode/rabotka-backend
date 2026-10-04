export { escapeHtml, wrapEmailHtml, type EmailLayoutOptions, type FooterInfo } from './layout';
export { sendWelcomeEmail, WELCOME_EMAIL_PREVIEW } from './welcome';
export {
  referralRewardedEmail,
  REFERRAL_REWARDED_EMAIL_PREVIEW,
  type ReferralRewardedEmailOptions,
} from './referral-rewarded';
export { sendOtpEmail } from './otp';
export { adminCreatedEmail } from './admin-created';
export { agentCreatedEmail } from './agent-created';
export {
  agentWithdrawalPaidEmail,
  agentWithdrawalRejectedEmail,
} from './agent-withdrawal';
export { adminUpdatedEmail } from './admin-updated';
export { kycApprovedEmail } from './kyc-approved';
export { kycRejectedEmail } from './kyc-rejected';
export { paymentRejectedEmail } from './payment-rejected';
export { paymentSuccessEmail } from './payment-success';
export { accountSuspendedEmail } from './account-suspended';
export { claimCreatedEmail } from './claim-created';
export { claimInProgressEmail } from './claim-in-progress';
export { claimCompletedEmail } from './claim-completed';
export { claimRejectedEmail } from './claim-rejected';
export { claimAssignedEmail } from './claim-assigned';
export { claimUnassignedEmail } from './claim-unassigned';
export { eventCreatedEmail } from './event-created';
export { eventUpdatedEmail } from './event-updated';
export { advertisementCreatedEmail } from './advertisement-created';
export { advertisementCompletedEmail } from './advertisement-completed';
export * from './broadcast';
