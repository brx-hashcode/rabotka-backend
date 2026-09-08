/**
 * True when the employer's fee for this offer was already collected at the job
 * level. On a multi-seat offer one payment covers every candidate, so an
 * attempt's `employer_paid` flag is cascaded rather than separately funded —
 * it must not be read as "money was collected for this attempt". Refunds and
 * revenue totals have to ask this before they trust the flag.
 */
export function isEmployerCoveredAtJobLevel(
  quantity: number | null | undefined,
  employerUnlockPaid: boolean,
): boolean {
  return (quantity ?? 1) > 1 && employerUnlockPaid;
}
