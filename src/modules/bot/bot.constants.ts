import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

export const BOT_STATE_KEY_PREFIX = `${REDIS_KEY_PREFIX}bot:state:`;

export const BOT_STATE_TTL_SECONDS = 86400;

// Shorter TTLs for flows that should expire if abandoned mid-conversation.
// Flows not listed here fall back to BOT_STATE_TTL_SECONDS (24h).
export const FLOW_TTL_SECONDS: Partial<Record<string, number>> = {
  cancel_application: 2 * 3600,
  accept_refuse_candidate: 2 * 3600,
  verify_whatsapp: 10 * 60, // 10 min — OTP-like, short window
  job_status_check: 30 * 60, // 30 min — re-triggered by reminder anyway
  post_cancellation_actions: 30 * 60, // 30 min
  republish_expired_job: 30 * 60, // 30 min
  rate_assignment: 2 * 3600,
  pay_penalties: 3600, // 1 h — holds payment intent
};

export const FLOW_IDS = {
  ACCEPT_REFUSE_CANDIDATE: 'accept_refuse_candidate',
  CANCEL_APPLICATION: 'cancel_application',
  JOB_STATUS_CHECK: 'job_status_check',
  PAY_PENALTIES: 'pay_penalties',
  /** Tiny state machine that handles the 1/2/3 menu shown to an employer
   *  after a worker cancels their candidature (see formatCancellationToEmployer). */
  POST_CANCELLATION_ACTIONS: 'post_cancellation_actions',
  RATE_ASSIGNMENT: 'rate_assignment',
  REPUBLISH_EXPIRED_JOB: 'republish_expired_job',
  VERIFY_WHATSAPP: 'verify_whatsapp',
} as const;

/**
 * Words that mean "get me out of here". There is no menu any more — inside a
 * live flow these exit it, and the orchestrator answers with the welcome card.
 *
 * `start` is the documented entry point. It belongs HERE rather than being
 * handled on its own, because until now it only worked by accident: unrecognised
 * input falls through to the welcome card, so `start` did nothing while a user
 * was mid-flow — which is precisely when someone types it. Someone stuck in the
 * penalty-payment flow had it parsed as a payment option and stayed stuck.
 * Listing it here gives it the escape behaviour every flow already honours.
 *
 * `démarrer`/`commencer` are here because a French-speaking user is at least as
 * likely to type those, and the cost is two array entries.
 */
export const CMD_MENU = [
  'menu',
  'aide',
  'help',
  'bonjour',
  '*',
  'start',
  'démarrer',
  'demarrer',
  'commencer',
];
export const CMD_PAY = [
  'payer',
  'régler',
  'regler',
  'payer pénalités',
  'payer penalites',
];

/**
 * Base URL for links the bot puts in a message.
 *
 * Must match `FRONTEND_URL`, because that is what
 * `WhatsAppOutboundProcessor.withLoginLinks` matches on when it rewrites a
 * first-party link into a one-tap `/s/<code>`. A hardcoded production URL looks
 * right and silently loses that rewrite in every other environment.
 */
export const APP_BASE_URL = (
  process.env.FRONTEND_URL ?? 'https://rabotka.work'
).replace(/\/+$/, '');
