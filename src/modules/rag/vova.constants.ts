/**
 * Runtime switches for the assistant, in `SystemConfig` so they move without a
 * deploy — the same pattern every other risky subsystem here uses.
 */
export const VOVA_CONFIG_KEYS = {
  /** Master switch. Off means the bot behaves exactly as it did before. */
  ENABLED: 'vova.enabled',
  /** Compute the reply, log it, send the welcome card anyway. */
  SHADOW_MODE: 'vova.shadow_mode',
  /** Percentage of profiles the assistant answers, bucketed by a stable hash. */
  ROLLOUT_PERCENT: 'vova.rollout_percent',
  /** Whole-turn budget. On expiry the bot falls back, silently to the user. */
  TIMEOUT_MS: 'vova.timeout_ms',
  /**
   * Answer numbers with no profile at all.
   *
   * Separate from `ENABLED` on purpose, and gated by it as well: answering
   * strangers is a different risk from answering verified users. It is the only
   * path where someone who has never signed up can spend tokens, so it must be
   * switchable off on its own, without taking the assistant down for the people
   * who do have accounts.
   */
  ANONYMOUS_ENABLED: 'vova.anonymous_enabled',
  /** AI replies allowed per unregistered phone per day. Past it, the card. */
  ANON_DAILY_LIMIT: 'vova.anon_daily_limit',
} as const;
