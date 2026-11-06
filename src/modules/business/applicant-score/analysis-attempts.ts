/**
 * How a CV analysis is tried again, for a Rabotka applicant and a careers-page
 * CV alike: each try is charged (and given back when it fails), so a CV the
 * model can't read must not be tried forever — every 2 minutes for oversized
 * ones, every 6 hours for 30 days for failed ones.
 */

/** Tries per application, the first included. */
export const MAX_ANALYSIS_ATTEMPTS = 3;
/** The wait after the first failure; doubled after each one. */
export const RETRY_BASE_MS = 6 * 60 * 60 * 1000;
/** A claim older than this was left by a run that died: free again. */
export const CLAIM_STALE_MS = 30 * 60 * 1000;

/**
 * Whether a failed analysis may be tried again now: fewer than the maximum
 * tries, and long enough since the last one failed (6 h, then 12 h…).
 */
export function retryDue(attempts: number, failedAt: Date, now: Date): boolean {
  if (attempts >= MAX_ANALYSIS_ATTEMPTS) return false;
  const wait = RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return now.getTime() - failedAt.getTime() >= wait;
}

/** The claim condition: nobody holds it, or the one who did has gone. */
export function claimable(now: Date) {
  return {
    OR: [
      { analysis_claimed_at: null },
      { analysis_claimed_at: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
    ],
  };
}
