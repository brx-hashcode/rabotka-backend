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
} as const;
