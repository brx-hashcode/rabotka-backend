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
  unlock_contact: 3600, // 1 h — holds payment intent
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
  UNLOCK_CONTACT: 'unlock_contact',
  VERIFY_WHATSAPP: 'verify_whatsapp',
} as const;

/**
 * Words that mean "get me out of here". There is no menu any more — inside a
 * live flow these exit it, and the orchestrator answers with the welcome card.
 */
export const CMD_MENU = ['menu', 'aide', 'help', 'bonjour', '*'];
export const CMD_PAY = [
  'payer',
  'régler',
  'regler',
  'payer pénalités',
  'payer penalites',
];