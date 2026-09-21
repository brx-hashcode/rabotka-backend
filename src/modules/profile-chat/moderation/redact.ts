import type { DetectedSpan } from './detect';
import type { RedactionCategory } from './patterns';

/**
 * What the recipient sees in place of a withheld fragment.
 *
 * Named by category rather than a single "[masqué]" for everyone: "[numéro
 * masqué]" tells the reader that somebody tried to send them a number, which is
 * the useful half. A blank would read as a glitch.
 */
const PLACEHOLDERS: Record<RedactionCategory, string> = {
  PHONE: '[numéro masqué]',
  EMAIL: '[email masqué]',
  MESSAGING_HANDLE: '[contact masqué]',
  URL: '[lien masqué]',
  OBFUSCATED_DIGITS: '[numéro masqué]',
};

/**
 * Replaces each detected span with its placeholder.
 *
 * THIS RUNS ON THE SERVER AND ITS OUTPUT IS WHAT THE RECIPIENT IS SENT. Doing
 * it in the client would leave the real number in the response body, one
 * network tab away, and the feature would be decoration. Nothing here is a
 * display concern.
 *
 * Spans are applied back to front so that earlier offsets stay valid while
 * later ones are being rewritten.
 */
export function redact(input: string, spans: readonly DetectedSpan[]): string {
  if (spans.length === 0) return input;

  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let out = input;
  for (const span of ordered) {
    out =
      out.slice(0, span.start) +
      PLACEHOLDERS[span.category] +
      out.slice(span.end);
  }
  return out;
}

/**
 * How much of the message was withheld, between 0 and 1.
 *
 * Feeds the rule that holds a message back entirely rather than delivering
 * confetti: a text that is mostly holes carries no meaning, and sending it
 * tells the recipient only that somebody tried something.
 */
export function redactedRatio(
  input: string,
  spans: readonly DetectedSpan[],
): number {
  if (!input.length || spans.length === 0) return 0;
  // Spans from `detectContacts` are already merged, so they cannot double-count.
  const covered = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
  return Math.min(1, covered / input.length);
}
