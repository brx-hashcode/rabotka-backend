/** A BUSINESS_SUBSCRIPTION payment request was paid: activate its period. */
export const BUSINESS_SUBSCRIPTION_PAID_EVENT = 'business.subscription.paid';

export type BusinessSubscriptionPaidPayload = { paymentRequestId: string };

/** A BUSINESS_CREDIT_PACK payment request was paid: add its credits. */
export const BUSINESS_CREDIT_PACK_PAID_EVENT = 'business.credit-pack.paid';

/** An admin approved a business: its trial starts (if configured). */
export const BUSINESS_VERIFIED_EVENT = 'business.verified';

/** `startTrial` false: the admin approved without the trial (absent: started). */
export type BusinessVerifiedPayload = {
  businessId: string;
  startTrial?: boolean;
};
