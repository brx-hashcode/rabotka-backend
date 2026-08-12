import { JobOfferStatus } from '@prisma/client';

/**
 * Offer statuses that close a posting for good. When an offer moves into one of
 * these, any applicants still waiting on it (PENDING / VIEWED / WAITING_PAYMENT)
 * can no longer be accepted and must be rejected + notified.
 */
export const TERMINAL_JOB_OFFER_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.CANCELLED,
  JobOfferStatus.COMPLETED,
  JobOfferStatus.EXPIRED,
];

/**
 * Whether an offer has been closed for good and must not be written back to a
 * recruiting status.
 *
 * Several paths reopen a slot when someone drops out — a worker cancelling, an
 * employer dropping a hire, a rejected unlock attempt — and each of them writes
 * ACTIVE or PARTIALLY_FILLED unconditionally. That was survivable while the only
 * way to reach COMPLETED was every worker confirming, days after the fact. Now
 * that an ongoing engagement closes the instant its last position is paid for,
 * those writes can land on a closed offer and put a fully-staffed post back on
 * the feed with its workers already at END.
 */
export function isTerminalJobOfferStatus(status: JobOfferStatus): boolean {
  return TERMINAL_JOB_OFFER_STATUSES.includes(status);
}
