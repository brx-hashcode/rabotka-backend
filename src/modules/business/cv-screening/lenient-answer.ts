import { z } from 'zod';

/**
 * What the models write, read as meant. Asked for JSON, they still answer
 * `"80"` for a mark, `"true"` for a yes, `null` inside a list: strictly
 * typed, the whole answer was refused for it, the CV marked failed or the
 * draft lost, after two paid calls.
 */

/** `"80"` → 80; anything else as it came, for the schema to judge. */
export const numberish = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) =>
      typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
        ? Number(v)
        : v,
    schema,
  );

/** `"true"` / `"false"` → the boolean. */
export const booleanish = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) =>
      typeof v === 'string' && /^(true|false)$/i.test(v.trim())
        ? v.trim().toLowerCase() === 'true'
        : v,
    schema,
  );

/** A list of short texts: `null` items dropped, a `null` list read as none. */
export const lenientLines = z.preprocess(
  (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : v),
  z.array(z.string().trim()).nullish(),
);

/**
 * The start of an answer that could not be read, for the log: what went
 * wrong is in its first lines. E-mail addresses and phone numbers are taken
 * out — the answer is about a candidate.
 */
export function answerSnippet(raw: string, max = 300): string {
  return raw
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[e-mail]')
    .replace(/\+?\d[\d\s.-]{6,}\d/g, '[téléphone]')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}
