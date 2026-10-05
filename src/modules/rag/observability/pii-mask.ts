import { EMAIL_PATTERN, PHONE_PATTERNS } from '../agent/guard.service';

/**
 * Strips contact details from everything a VoVa trace exports.
 *
 * Traces go to Langfuse Cloud, off our VPS, and they carry the raw WhatsApp
 * exchange: what a worker typed, what tools returned, what the model said.
 * People write their numbers into messages all the time, and tool outputs
 * (`etat_deblocage`, `mes_candidatures`) can carry a counterpart's contact.
 *
 * The expressions are the guard's own, rebuilt from `.source` with `g` — the
 * pattern `guard.service.ts` documents for sharing them — so the filter that
 * stops VoVa from SAYING a number and the one that stops a trace from
 * EXPORTING one cannot drift apart.
 */
const MASKS: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(EMAIL_PATTERN.source, 'g'), '[email]'],
  ...PHONE_PATTERNS.map(
    ([, re]) => [new RegExp(re.source, 'g'), '[phone]'] as const,
  ),
];

export function maskText(text: string): string {
  let out = text;
  for (const [re, label] of MASKS) out = out.replace(re, label);
  return out;
}

/**
 * Deep: span inputs and outputs are message arrays, tool payloads and
 * metadata objects, not only strings. Keys are kept — they are field names,
 * not user data — and non-string leaves pass through untouched.
 */
export function maskPii(data: unknown, depth = 0): unknown {
  if (typeof data === 'string') return maskText(data);
  if (depth > 12 || data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((v) => maskPii(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = maskPii(v, depth + 1);
  return out;
}
