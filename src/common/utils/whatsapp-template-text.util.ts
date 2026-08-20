/**
 * Normalisation for text placed inside a WhatsApp template variable.
 *
 * Meta rejects a send (error 132018) when any template parameter contains a
 * newline, a tab, or a run of 4+ spaces. That rule applies to EVERY variable of
 * EVERY template, so this lives in `common/` rather than beside any one
 * template: the provider mappers apply it at their chokepoints, and the registry
 * applies it to the free-text bindings where the emptiness fallback has to see
 * the flattened value.
 *
 * MIRRORED CLIENT-SIDE in rabotka-admin/src/lib/whatsapp-template-text.ts, which
 * counts the admin composer's characters against the same rule. If the pipeline
 * below changes, change it there too.
 */

/**
 * Collapse `text` onto a single line Meta will accept.
 *
 * Pass order is load-bearing: collapsing spaces and tabs BEFORE the newline
 * passes stops `"a  \n  b"` from leaving a doubled space behind, and the final
 * pass mops up whatever inserting the separator created.
 *
 * Paragraph breaks become a visible `·` rather than a plain space — flattening
 * a three-paragraph message with spaces alone produces an unreadable run-on.
 *
 * Returns an empty string for input that was only whitespace — the leading
 * `.trim()` covers that on its own. What it does NOT do is second-guess text
 * that survived: `"·"` comes back as `"·"`. `flattenForTemplateVariable` is the
 * variant that treats a separators-only result as empty, which is a decision
 * only a caller with a fallback to fall back TO can make. A provider mapper has
 * none, so it uses this one and lets a genuinely blank value fail as the blank
 * it is (132000) rather than masking it.
 */
export function sanitizeTemplateVariable(text: string): string {
  return (
    text
      // Up front, so leading/trailing blank lines never become an edge separator.
      .trim()
      .replace(/\r\n?/g, '\n')
      // Control and format characters (zero-width joiners, bidi marks) survive
      // a copy-paste out of a browser and are rejected inside a variable. \n and
      // \t are control characters too, so they are spared here and normalised by
      // the passes below. Written as Unicode property escapes so this file needs
      // no literal control bytes of its own.
      .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, ' · ')
      .replace(/\n/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

/**
 * `sanitizeTemplateVariable`, but text that carried no content at all comes back
 * empty rather than as bare separators.
 *
 * A message that was only blank lines flattens to nothing but separators, which
 * would sail past a caller's emptiness check and send a lone "·". Tested rather
 * than stripped: one anchored character class, no backtracking.
 */
export function flattenForTemplateVariable(text: string): string {
  const flattened = sanitizeTemplateVariable(text);

  return /^[·\s]*$/.test(flattened) ? '' : flattened;
}

/**
 * Ceiling on a single free-text variable.
 *
 * Meta's rendered BODY cap is 1024 characters, shared between the template's
 * static text and every variable in it. None of the free-text fields upstream is
 * length-bounded — neither `AdminVerifyProfileDto.reason` nor a worker's profile
 * description declares a max — so a pasted essay would fail the send outright.
 *
 * 600 leaves room for the longest static body in the registry plus a name, and
 * is deliberately conservative for the same reason as `ADMIN_MESSAGE_VAR_MAX`:
 * accented French counts unevenly against Meta's own measure. Raise it once a
 * real send establishes the actual threshold.
 */
export const FREE_TEXT_VAR_MAX = 600;

/**
 * Truncate an already-sanitized variable to `max` characters, ellipsis included.
 *
 * SILENTLY SHORTENS. Deliberate: the alternative considered was a 400 at the DTO
 * rejecting the admin's reason outright, and a rejection that still reaches the
 * user truncated beats one that never sends at all.
 *
 * Cuts on a word boundary when there is one in the last fifth of the budget —
 * short enough that a boundary-less string (a pasted URL, a language that does
 * not space its words) falls back to a hard cut instead of losing most of the
 * text.
 */
export function capTemplateVar(
  text: string,
  max: number = FREE_TEXT_VAR_MAX,
): string {
  if (text.length <= max) return text;

  const budget = max - 1; // The ellipsis is one character and counts.
  const hard = text.slice(0, budget);
  const lastSpace = hard.lastIndexOf(' ');

  const cut = lastSpace >= budget * 0.8 ? hard.slice(0, lastSpace) : hard;

  return `${cut.trimEnd()}…`;
}
