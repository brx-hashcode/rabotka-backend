/** Penalty amount in FCFA when worker cancels less than 4h before scheduled time */
export const LATE_CANCELLATION_PENALTY_FCFA = 5000;

/** Reliability score deduction per late cancellation */
export const LATE_CANCELLATION_SCORE_DEDUCTION = 5;

/** Maximum reliability score */
export const RELIABILITY_SCORE_MAX = 100;

/** Number of unpaid penalties that triggers account suspension */
export const PENALTY_SUSPENSION_THRESHOLD = Number(
  process.env.PENALTY_THRESHOLD ?? 3,
);
