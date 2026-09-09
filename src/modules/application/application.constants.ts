import { ApplicationCancelledBy, ApplicationStatus } from '@prisma/client';

/**
 * Maximum reliability score.
 *
 * The ceiling of the scale itself, not a tunable — the floor is
 * `fees.reliability_score_min` in SystemConfig, but a "score out of 100" that
 * an admin can move to 80 is no longer a score out of 100. Every message that
 * renders it writes "/100".
 *
 * The late-cancellation penalty, its score deduction, and the unpaid-penalty
 * suspension threshold used to live here too. They are SystemConfig keys now
 * — `fees.late_cancellation_penalty_fcfa`,
 * `fees.late_cancellation_score_deduction` and
 * `fees.penalty_suspension_threshold` — because the service charged the
 * configured value while the WhatsApp cancel flow quoted the constant, so
 * changing the price in admin made the bot promise one figure and debit
 * another.
 */
export const RELIABILITY_SCORE_MAX = 100;

/**
 * The columns every cancellation must write, in one place.
 *
 * There are four cancel paths — worker, employer, offer expiry, unlock lapse —
 * and they live in three different files. `cancelled_by` is the field a new one
 * is most likely to forget, and forgetting it fails OPEN: the row reads as
 * "unknown canceller" and the worker may re-apply.
 *
 * This is the cheap version of a CHECK constraint. A real one would have to be
 * `NOT VALID`, which Postgres still enforces on every UPDATE — so any later
 * touch of a legacy NULL row would start failing. A shared shape plus tests
 * instead.
 *
 * Shaped to satisfy both `update` and `updateMany`, since the two system paths
 * use the latter.
 */
export function cancellationPatch(args: {
  by: ApplicationCancelledBy;
  at: Date;
  reason: string | null;
}) {
  return {
    status: ApplicationStatus.CANCELLED,
    cancelled_at: args.at,
    cancelled_by: args.by,
    cancellation_reason: args.reason,
  };
}

/** What `create()` may do about an existing row for this (offer, worker). */
export type ReapplyDecision =
  | 'ALLOW'
  | 'BLOCKED_ACTIVE'
  | 'BLOCKED_SELF_CANCELLED';

export const SELF_CANCELLED_MESSAGE =
  'Vous avez annulé cette candidature. Vous ne pouvez plus postuler à cette offre.';

/**
 * Whether a worker may apply, given every row they already have on this offer.
 *
 * Pure, so the rule can be tested without Prisma — the guard around it does the
 * fetching and the throwing.
 *
 * The rule: only a worker's OWN cancellation bars them. An employer's
 * cancellation, or one of the platform's timeouts, leaves them free to apply
 * again — they did not walk away.
 *
 * A live row of any other status still blocks exactly as before, so this change
 * is scoped to cancellations and nothing else.
 */
export function reapplyDecision(
  rows: readonly {
    status: ApplicationStatus;
    cancelled_by: ApplicationCancelledBy | null;
    deleted_at: Date | null;
  }[],
): ReapplyDecision {
  const live = rows.filter((r) => r.deleted_at === null);

  // Anything not cancelled is a live application: PENDING, VIEWED,
  // WAITING_PAYMENT, ACCEPTED, REJECTED, STARTED, END all keep today's 409.
  if (live.some((r) => r.status !== ApplicationStatus.CANCELLED)) {
    return 'BLOCKED_ACTIVE';
  }

  if (
    live.some(
      (r) => r.cancelled_by === ApplicationCancelledBy.WORKER,
    )
  ) {
    return 'BLOCKED_SELF_CANCELLED';
  }

  // Reached when every row is cancelled by the employer, by the system, or by
  // someone we cannot identify. NULL is the pre-migration case and it is
  // DELIBERATELY permissive — see the column comment in schema.prisma. Do not
  // "fix" it to bar: it would bar the ghost-cancel victims for good.
  return 'ALLOW';
}
