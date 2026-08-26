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
