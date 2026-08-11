import { WhatsappError, type WhatsappErrorCode } from '../../contracts';

/**
 * A Twilio send failure, carrying the SDK's numeric code alongside the message
 * the admin back office already displays.
 *
 * `TwilioService` formats that message (`[Twilio 63016] … — message to … failed`)
 * and it is surfaced verbatim in an admin toast, so it must not change. The
 * subclass exists only so the code survives the throw: previously it was
 * formatted into the string and then unavailable to anything upstream, which is
 * why no caller could tell a closed 24h window from a dead credential.
 */
export class TwilioSendError extends Error {
  readonly code: number | null;
  readonly status: number | null;

  constructor(message: string, code?: number | null, status?: number | null) {
    super(message);
    this.name = 'TwilioSendError';
    this.code = code ?? null;
    this.status = status ?? null;
  }
}

/**
 * Twilio error code -> our internal code.
 *
 * Only 63038 and 63031 were ever branched on in this codebase; the rest come
 * from Twilio's WhatsApp error reference and exist so behaviour is defined the
 * first time they occur rather than after an incident.
 */
const BY_CODE: ReadonlyMap<number, WhatsappErrorCode> = new Map([
  // Outside the 24h customer-service window — free-form text was rejected.
  [63016, 'OUTSIDE_MESSAGING_WINDOW'],
  // Not a WhatsApp user / not a valid destination.
  [63024, 'INVALID_RECIPIENT'],
  [21211, 'INVALID_RECIPIENT'],
  [63003, 'INVALID_RECIPIENT'],
  // Rate limited by Twilio or by Meta upstream.
  [63018, 'RATE_LIMITED'],
  [63021, 'RATE_LIMITED'],
  // Template (Content) problems.
  [63005, 'TEMPLATE_NOT_FOUND'],
  [63007, 'TEMPLATE_NOT_FOUND'],
  // Credentials.
  [20003, 'AUTH_FAILED'],
  // Sandbox: 50 messages/day, then everything is dropped until the next day.
  [63038, 'SANDBOX_LIMIT_REACHED'],
  // Sender and recipient are the same number.
  [63031, 'SENDER_IS_RECIPIENT'],
  // Media rejected or unfetchable.
  [63019, 'MEDIA_ERROR'],
  [63020, 'MEDIA_ERROR'],
]);

interface TwilioLikeError {
  code?: number | null;
  status?: number | null;
  message?: string;
}

function readTwilioError(err: unknown): TwilioLikeError {
  if (err instanceof TwilioSendError) {
    return { code: err.code, status: err.status, message: err.message };
  }
  if (err && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    return {
      code: typeof record.code === 'number' ? record.code : null,
      status: typeof record.status === 'number' ? record.status : null,
      // Never `String(err)` on the object: an SDK error without a `message`
      // stringifies to "[object Object]", which is worse than saying nothing.
      message:
        typeof record.message === 'string'
          ? record.message
          : 'Unknown Twilio error',
    };
  }
  return {
    code: null,
    status: null,
    message: typeof err === 'string' ? err : 'Unknown Twilio error',
  };
}

export function twilioErrorCode(err: unknown): WhatsappErrorCode {
  const { code } = readTwilioError(err);
  if (code === null || code === undefined) return 'UNKNOWN';
  return BY_CODE.get(code) ?? 'UNKNOWN';
}

/**
 * Normalize a Twilio throw into a `WhatsappError`.
 *
 * The message is passed through UNCHANGED — `WhatsAppService.sendAdminMessage`
 * puts it straight in front of an admin, and rewording it here would change
 * what they read for no gain.
 */
export function toWhatsappError(err: unknown): WhatsappError {
  const { code, status, message } = readTwilioError(err);
  return new WhatsappError({
    code: twilioErrorCode(err),
    provider: 'twilio',
    message: message ?? 'Unknown Twilio error',
    providerCode: code ?? status ?? null,
    raw: err,
  });
}
