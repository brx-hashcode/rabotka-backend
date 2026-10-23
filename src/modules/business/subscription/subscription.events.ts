/** A BUSINESS_SUBSCRIPTION payment request was paid: activate its period. */
export const BUSINESS_SUBSCRIPTION_PAID_EVENT = 'business.subscription.paid';

export type BusinessSubscriptionPaidPayload = { paymentRequestId: string };

/** An admin approved a business: its trial starts (if configured). */
export const BUSINESS_VERIFIED_EVENT = 'business.verified';

export type BusinessVerifiedPayload = { businessId: string };
