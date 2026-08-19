export type LlmErrorClass =
  | 'rate_limit'
  | 'server'
  | 'transport'
  | 'provider_unusable'
  | 'fatal';

function statusOf(err: unknown): number | null {
  const e = err as Record<string, any> | null;
  if (!e || typeof e !== 'object') return null;
  const candidates = [
    e.status,
    e.statusCode,
    e.code,
    e.response?.status,
    e.response?.statusCode,
    e.cause?.status,
  ];
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 600) {
      return n;
    }
  }
  return null;
}

const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

const CONTENT_BLOCK = [
  'content filter',
  'content_filter',
  'content management policy',
  'safety',
  'prohibited_content',
  'blocklist',
  'responsible ai',
  'recitation',
];

const RATE_LIMIT_TEXT = [
  'rate limit',
  'rate_limit',
  'quota',
  'too many requests',
];

const TIMEOUT_TEXT = ['timeout', 'timed out', 'aborted', 'abort'];

/**
 * A provider that cannot represent the messages we are sending it.
 *
 * Observed live: with a LangGraph tool-calling loop, `@langchain/mistralai`
 * rejects the agent's own message history with "Mistral only supports types
 * 'text' or 'image_url' for complex message types". No status code, so without
 * this it lands in `transport` and the chain keeps paying for it on every turn.
 *
 * It is provider-specific and permanent for this shape of conversation, which
 * is exactly `provider_unusable`: fall over, and open the breaker so we stop
 * spending latency to rediscover it.
 */
const INCOMPATIBLE_TEXT = [
  'only supports types',
  'complex message types',
  'unsupported message type',
  'does not support tool',
  'tools are not supported',
];

function isProgrammerError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    err instanceof ReferenceError ||
    err instanceof SyntaxError ||
    err instanceof RangeError
  );
}

export function classifyLlmError(err: unknown): LlmErrorClass {
  if (isProgrammerError(err)) return 'fatal';

  const e = err as { message?: unknown; name?: unknown; code?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  const name = typeof e?.name === 'string' ? e.name : '';
  const code = typeof e?.code === 'string' ? e.code : '';

  if (CONTENT_BLOCK.some((t) => message.includes(t))) return 'fatal';

  const status = statusOf(err);
  if (status !== null) {
    if (status === 429) return 'rate_limit';
    if (status >= 500) return 'server';
    if (status === 408) return 'transport';
    if (status === 401 || status === 403 || status === 404) {
      return 'provider_unusable';
    }
    if (status >= 400) return 'fatal';
  }

  if (INCOMPATIBLE_TEXT.some((t) => message.includes(t))) {
    return 'provider_unusable';
  }

  if (TRANSPORT_CODES.has(code)) return 'transport';
  if (name === 'AbortError' || name === 'TimeoutError') return 'transport';
  if (TIMEOUT_TEXT.some((t) => message.includes(t))) return 'transport';
  if (RATE_LIMIT_TEXT.some((t) => message.includes(t))) return 'rate_limit';

  return 'transport';
}

export function isRetryableInPlace(cls: LlmErrorClass): boolean {
  return cls === 'server';
}

export function mayFallOver(cls: LlmErrorClass): boolean {
  return cls !== 'fatal';
}

export function shouldTripBreaker(cls: LlmErrorClass): boolean {
  return cls !== 'fatal';
}
