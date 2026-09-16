import { REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';

/**
 * How long the person has to answer.
 *
 * A day, because the request arrives on WhatsApp and is often read hours
 * later. It also matches the lifetime of the one-tap login code in the
 * message's button, so the link never outlives the check or dies before it.
 */
export const IDENTITY_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Consent requests one app may send to one number in a day.
 *
 * Beyond this the check is still accepted and answered exactly like any other
 * — so the cap reveals nothing — but no WhatsApp message goes out. It exists so
 * a buggy or hostile partner cannot flood a person's phone.
 */
export const MAX_CONSENT_REQUESTS_PER_PHONE_PER_DAY = 3;

/** Checks one app may create per minute, across all its callers. */
export const APP_CHECKS_PER_MINUTE = 30;

/** How long the partner's claimed identity is kept once a check has ended. */
export const CLAIMED_RETENTION_DAYS = 90;

/** How often expired checks are closed and old claims purged. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Webhook delivery attempts, with exponential backoff from `WEBHOOK_BACKOFF_MS`.
 * Eight attempts from 30s span roughly two hours, which outlasts an ordinary
 * partner deploy or outage. After that the result is still available by GET.
 */
export const WEBHOOK_MAX_ATTEMPTS = 8;
export const WEBHOOK_BACKOFF_MS = 30_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The `typ` header on webhook JWS, so a partner cannot mistake one for an ID token. */
export const WEBHOOK_JWS_TYPE = 'rabotka-identity-check+jwt';

/** Where the consent button lands in rabotka-client. */
export function identityCheckCtaPath(checkId: string): string {
  return `identity-checks/${checkId}`;
}

const NS = `${REDIS_KEY_PREFIX}identity-check:`;

export const IDENTITY_CHECK_KEYS = {
  appRate: (appId: string, minute: number) => `${NS}rate:${appId}:${minute}`,
} as const;
