/** Penalty amount in FCFA when worker cancels less than 4h before scheduled time */
export const LATE_CANCELLATION_PENALTY_FCFA = 5000;

/** Reliability score deduction per late cancellation */
export const LATE_CANCELLATION_SCORE_DEDUCTION = 5;

/** Minimum hours before scheduled_at for cancellation without penalty */
export const CANCELLATION_PENALTY_THRESHOLD_HOURS = 4;

/** Minimum reliability score (cap) */
export const RELIABILITY_SCORE_MIN = 50;

/** Maximum reliability score */
export const RELIABILITY_SCORE_MAX = 100;
