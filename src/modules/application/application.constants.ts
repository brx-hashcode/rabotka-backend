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
  'ALLOW' | 'BLOCKED_ACTIVE' | 'BLOCKED_SELF_CANCELLED';

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

  if (live.some((r) => r.cancelled_by === ApplicationCancelledBy.WORKER)) {
    return 'BLOCKED_SELF_CANCELLED';
  }

  // Reached when every row is cancelled by the employer, by the system, or by
  // someone we cannot identify. NULL is the pre-migration case and it is
  // DELIBERATELY permissive — see the column comment in schema.prisma. Do not
  // "fix" it to bar: it would bar the ghost-cancel victims for good.
  return 'ALLOW';
}

/**
 * Statuses in which the worker had committed — accepted, paying for the
 * contact, or hired on an ongoing engagement. Walking away from one of these
 * is what costs reliability points (see cancellationScoreDeduction).
 */
export const COMMITTED_CANCEL_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.END,
];

export function isCommittedCancellation(
  fromStatus: ApplicationStatus,
): boolean {
  return COMMITTED_CANCEL_STATUSES.includes(fromStatus);
}

/**
 * Statuses from which a worker's cancellation counts toward the
 * repeated-cancellation suspension: every one they make themselves — the
 * committed ones, and withdrawing an application still waiting for an answer
 * too. Someone who keeps applying and pulling out is the pattern this rule
 * is for, whether or not the employer had answered yet. Withdrawals cost no
 * reliability points; only committed cancellations do.
 */
export const SUSPENSION_COUNTED_CANCEL_STATUSES: readonly ApplicationStatus[] =
  [
    ApplicationStatus.PENDING,
    ApplicationStatus.VIEWED,
    ...COMMITTED_CANCEL_STATUSES,
  ];

export function countsTowardSuspension(fromStatus: ApplicationStatus): boolean {
  return SUSPENSION_COUNTED_CANCEL_STATUSES.includes(fromStatus);
}

/**
 * Where a worker stands against the repeated-cancellation rule, given how
 * many counted cancellations they already have in the window. Pure, so the
 * preview and the cancel itself cannot disagree.
 */
export function cancellationSuspensionOutlook(args: {
  /** Counted cancellations already in the window, this one excluded. */
  priorInWindow: number;
  /** Whether THIS cancellation would count. */
  counts: boolean;
  threshold: number;
}): { afterThis: number; wouldSuspend: boolean; remaining: number | null } {
  const threshold = Number.isFinite(args.threshold) ? args.threshold : 0;
  const afterThis = args.priorInWindow + (args.counts ? 1 : 0);
  if (threshold <= 0) {
    return { afterThis, wouldSuspend: false, remaining: null };
  }
  return {
    afterThis,
    wouldSuspend: args.counts && afterThis >= threshold,
    remaining: Math.max(0, threshold - afterThis),
  };
}

/**
 * Reliability points a worker cancellation costs: the late-cancellation
 * deduction when it is late, plus `fees.cancellation_score_deduction` for
 * walking away from any committed mission (see isCommittedCancellation),
 * early or late. Pure, so the cancel and its preview agree.
 */
export function cancellationScoreDeduction(args: {
  late: boolean;
  committed: boolean;
  lateDeduction: number;
  anyDeduction: number;
}): number {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return (
    (args.late ? safe(args.lateDeduction) : 0) +
    (args.committed ? safe(args.anyDeduction) : 0)
  );
}
