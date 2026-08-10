import { WhatsappError, type WhatsappErrorCode } from '../../contracts';
import type { CloudErrorBody } from './cloud.types';

/**
 * Meta error code -> our internal code.
 *
 * Cloud reports both a `code` and sometimes an `error_subcode`; the top-level
 * code is the one worth branching on. Anything absent here maps to UNKNOWN, is
 * retried once, and is surfaced with the raw payload attached.
 */
const BY_CODE: ReadonlyMap<number, WhatsappErrorCode> = new Map([
  // Re-engagement outside the 24h customer-service window.
  [131047, 'OUTSIDE_MESSAGING_WINDOW'],
  [131051, 'OUTSIDE_MESSAGING_WINDOW'],
  // Recipient cannot receive: not on WhatsApp, or the number is malformed.
  [131026, 'INVALID_RECIPIENT'],
  [131009, 'INVALID_RECIPIENT'],
  [131021, 'SENDER_IS_RECIPIENT'],
  // Throughput limits — business-level and app-level respectively.
  [130429, 'RATE_LIMITED'],
  [80007, 'RATE_LIMITED'],
  [131048, 'RATE_LIMITED'],
  // Template missing, unapproved, or its params do not match the approved body.
  [132001, 'TEMPLATE_NOT_FOUND'],
  [132000, 'TEMPLATE_NOT_FOUND'],
  [132005, 'TEMPLATE_NOT_FOUND'],
  [132007, 'TEMPLATE_NOT_FOUND'],
  [132012, 'TEMPLATE_NOT_FOUND'],
  [132015, 'TEMPLATE_NOT_FOUND'],
  [132068, 'TEMPLATE_NOT_FOUND'],
  [132069, 'TEMPLATE_NOT_FOUND'],
  // Expired or revoked token, or the app lacks the permission.
  [190, 'AUTH_FAILED'],
  // "Access denied" on a SEND while reads still succeed. Observed from a
  // temporary token that had gone stale without reaching its hard expiry — the
  // fix is to regenerate, so retrying the same token is pure waste.
  [131005, 'AUTH_FAILED'],
  [102, 'AUTH_FAILED'],
  [10, 'AUTH_FAILED'],
  [200, 'AUTH_FAILED'],
  // Media could not be downloaded, or is an unsupported type.
  [131053, 'MEDIA_ERROR'],
  [131052, 'MEDIA_ERROR'],
]);

export function cloudErrorCode(
  code: number | null | undefined,
): WhatsappErrorCode {
  if (code === null || code === undefined) return 'UNKNOWN';
  return BY_CODE.get(code) ?? 'UNKNOWN';
}

/**
 * A transport failure — the request never produced a Graph response body.
 * Timeouts and socket errors are retryable in a way a 4xx is not, so they get
 * their own code rather than collapsing into UNKNOWN.
 */
export function transportError(message: string, raw: unknown): WhatsappError {
  return new WhatsappError({
    code: 'TRANSPORT_ERROR',
    provider: 'cloud',
    message,
    providerCode: null,
    raw,
  });
}

/**
 * The human-readable half of a Graph failure.
 *
 * `[Cloud 131047/2494055] Re-engagement message — <details>`, or a bare HTTP
 * line when Meta returned something that was not an error envelope at all
 * (a gateway page, usually).
 */
function formatMessage(
  status: number,
  body: CloudErrorBody | null,
  fallbackMessage: string,
): string {
  if (!body) return `[Cloud HTTP ${status}] ${fallbackMessage}`;

  const subcode = body.error.error_subcode
    ? `/${body.error.error_subcode}`
    : '';
  const details = body.error.error_data?.details;
  const suffix = details ? ` — ${details}` : '';

  return `[Cloud ${body.error.code}${subcode}] ${body.error.message}${suffix}`;
}

export function toWhatsappError(
  status: number,
  body: CloudErrorBody | null,
  fallbackMessage: string,
  raw: unknown,
): WhatsappError {
  const metaCode = body?.error.code ?? null;
  let code = cloudErrorCode(metaCode);

  // A 429 or 5xx with an unrecognized code is still plainly retryable; leaving
  // it UNKNOWN would retry once instead of backing off properly.
  if (code === 'UNKNOWN' && (status === 429 || status >= 500)) {
    code = 'RATE_LIMITED';
  }

  return new WhatsappError({
    code,
    provider: 'cloud',
    message: formatMessage(status, body, fallbackMessage),
    providerCode: metaCode,
    raw,
  });
}
