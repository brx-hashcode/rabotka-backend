// A paid plan period or credit pack travels as the durable `payment.approved`
// domain event (src/common/events/domain), not on this in-memory bus.

/** An admin approved a business: its trial starts (if configured). */
export const BUSINESS_VERIFIED_EVENT = 'business.verified';

/** `startTrial` false: the admin approved without the trial (absent: started). */
export type BusinessVerifiedPayload = {
  businessId: string;
  startTrial?: boolean;
};
