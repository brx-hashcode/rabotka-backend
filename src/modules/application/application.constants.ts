/** Penalty amount in FCFA when worker cancels less than 4h before scheduled time */
export const LATE_CANCELLATION_PENALTY_FCFA = 5000;

/** Reliability score deduction per late cancellation */
export const LATE_CANCELLATION_SCORE_DEDUCTION = 5;

/**
 * Default only — runtime value comes from system config `fees.cancellation_threshold_hours`
 * (see SystemConfigService.getFees().cancellationThresholdHours).
 */
export const CANCELLATION_PENALTY_THRESHOLD_HOURS = 4;

/** Minimum reliability score (cap) */
export const RELIABILITY_SCORE_MIN = 50;

/** Maximum reliability score */
export const RELIABILITY_SCORE_MAX = 100;

/** Employer score deduction when they cancel an accepted worker */
export const EMPLOYER_CANCEL_SCORE_DEDUCTION = 5;

/** Employer score deduction when job expires with an accepted worker (ghost) */
export const EMPLOYER_GHOST_SCORE_DEDUCTION = 10;

/** Number of unpaid penalties before billing_status becomes BLOCKED */
export const BILLING_BLOCK_THRESHOLD = 2;

/** Number of unpaid penalties that triggers account suspension */
export const PENALTY_SUSPENSION_THRESHOLD = Number(
  process.env.PENALTY_THRESHOLD ?? 3,
);
