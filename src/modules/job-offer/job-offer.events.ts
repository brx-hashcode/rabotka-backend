/** An employer closed an open offer: those waiting on it must hear. */
export const JOB_OFFER_CLOSED = 'job-offer.closed';

export type JobOfferClosedEvent = { jobOfferId: string; employerId: string };
