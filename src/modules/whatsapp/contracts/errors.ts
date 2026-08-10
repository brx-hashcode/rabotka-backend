import type { Capability } from './capabilities';
import type { ProviderName } from './messages.types';

/**
 * Provider-independent failure codes.
 *
 * The point of this union is that callers branch on OUR code, never on a Twilio
 * number or a Meta one. Adding a provider means extending that provider's own
 * `errors.ts` mapper, not this list.
 */
export type WhatsappErrorCode =
  /** 24h customer-service window closed. Do not retry; send a template instead. */
  | 'OUTSIDE_MESSAGING_WINDOW'
  /** Not a reachable WhatsApp number. Do not retry; mark the contact unreachable. */
  | 'INVALID_RECIPIENT'
  /** Provider-side throttling. Retry with backoff. */
  | 'RATE_LIMITED'
  /** The template does not exist or is not approved. Do not retry; alert. */
  | 'TEMPLATE_NOT_FOUND'
  /** Credentials rejected. Do not retry; alert loudly — every send is failing. */
  | 'AUTH_FAILED'
  /**
   * No client at all — credentials absent, so nothing was even attempted.
   * Distinct from `AUTH_FAILED` because the admin back office reports it
   * differently ("WhatsApp is not configured" rather than a provider error),
   * and because it is the expected state in a dev environment with no
   * credentials rather than an incident.
   */
  | 'NOT_CONFIGURED'
  /**
   * Twilio sandbox only: 50 messages/day, then everything is dropped. Kept as
   * its own code because it looks like a rate limit but waiting does not help
   * until the next UTC day, and it never occurs on a paid number.
   */
  | 'SANDBOX_LIMIT_REACHED'
  /** Sender and recipient are the same number — a webhook/callback misconfiguration. */
  | 'SENDER_IS_RECIPIENT'
  /** Media rejected: unsupported type, too large, or the URL was unreachable. */
  | 'MEDIA_ERROR'
  /** Nothing matched. Retried once, then surfaced with the raw payload attached. */
  | 'UNKNOWN';

/** Codes where retrying the identical request can plausibly succeed. */
const RETRYABLE: ReadonlySet<WhatsappErrorCode> = new Set<WhatsappErrorCode>([
  'RATE_LIMITED',
  'UNKNOWN',
]);

export function isRetryable(code: WhatsappErrorCode): boolean {
  return RETRYABLE.has(code);
}

/**
 * A normalized provider failure.
 *
 * `providerCode` and `raw` are kept for logs and for the `UNKNOWN` case, which
 * is only actionable with the original payload in hand. Neither is ever
 * persisted, and `raw` must never reach a log line that could contain the
 * access token.
 */
export class WhatsappError extends Error {
  readonly code: WhatsappErrorCode;
  readonly provider: ProviderName;
  readonly providerCode: string | number | null;
  readonly retryable: boolean;
  readonly raw: unknown;

  constructor(params: {
    code: WhatsappErrorCode;
    provider: ProviderName;
    message: string;
    providerCode?: string | number | null;
    raw?: unknown;
  }) {
    super(params.message);
    this.name = 'WhatsappError';
    this.code = params.code;
    this.provider = params.provider;
    this.providerCode = params.providerCode ?? null;
    this.retryable = isRetryable(params.code);
    this.raw = params.raw;
  }
}

/**
 * Thrown when a caller asks for something the active provider genuinely cannot
 * do — a carousel on a provider with no carousel support, say.
 *
 * Deliberately raised at CALL TIME, not at boot: a capability gap only matters
 * on the code path that needs it, and failing the whole process at startup
 * because one rarely-used message type is unavailable would be a far worse
 * trade. Callers that can degrade gracefully should ask
 * `WhatsAppService.supports()` first rather than catching this.
 */
export class WhatsappCapabilityError extends Error {
  readonly provider: ProviderName;
  readonly capability: Capability;

  constructor(provider: ProviderName, capability: Capability) {
    super(`WhatsApp provider "${provider}" does not support ${capability}`);
    this.name = 'WhatsappCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}
