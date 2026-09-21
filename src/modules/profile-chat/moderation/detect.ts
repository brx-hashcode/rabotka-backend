import { foldWithOffsets, toSourceSpan, type Span } from './normalize';
import {
  BASE_PATTERNS,
  operatorPrefixPattern,
  type PatternSpec,
  type RedactionCategory,
} from './patterns';

export interface DetectedSpan extends Span {
  readonly category: RedactionCategory;
  /** Which rule fired. Stored per match so a noisy pattern can be found by query. */
  readonly matchedBy: string;
}

export interface DetectOptions {
  /** Local operator prefixes, from configuration. */
  readonly operatorPrefixes?: readonly string[];
  /** Categories to skip — one family can be noisy without the rest being wrong. */
  readonly disabled?: readonly RedactionCategory[];
}

/**
 * Longest input this will scan.
 *
 * Not a product limit — the DTO sets that, lower. This is a floor under the
 * regex engine. These expressions came from `GuardService`, where they only
 * ever saw text the MODEL produced; here they see text a user typed, and a few
 * of them backtrack super-linearly on a long unlucky string. A bound is a
 * cheaper answer than rewriting four expressions that work.
 *
 * Over the bound the text is scanned up to the cut rather than skipped: a
 * message that long is already a product bug, and quietly letting all of it
 * through unchecked would be the wrong failure.
 */
const MAX_SCAN_LENGTH = 4_000;

function matchAll(
  text: string,
  spec: PatternSpec,
  priority: number,
): (DetectedSpan & { priority: number })[] {
  const out: (DetectedSpan & { priority: number })[] = [];
  // Built per call via `new RegExp` upstream, but reset anyway: a `g` regex
  // carries `lastIndex`, and a stale one silently skips the start of the text.
  spec.pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = spec.pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      // A zero-width match never advances `lastIndex`; without this the loop
      // never ends.
      spec.pattern.lastIndex += 1;
      continue;
    }
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      category: spec.category,
      matchedBy: spec.id,
      priority,
    });
  }
  return out;
}

/**
 * Merges overlapping and touching spans into one.
 *
 * Touching, not just overlapping: `+242 06 12 34 56` can be two adjacent
 * matches from two patterns, and showing the sender two separate holes in one
 * phone number tells them less than showing one.
 *
 * The surviving category and rule are those of the highest-priority span in the
 * group, not of the one that happened to start first — an email swallowed by a
 * looser handle match should still read as an email.
 */
function merge(
  spans: (DetectedSpan & { priority: number })[],
): DetectedSpan[] {
  if (spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) =>
    a.start === b.start ? a.end - b.end : a.start - b.start,
  );

  const merged: DetectedSpan[] = [];
  let current = sorted[0];

  for (const span of sorted.slice(1)) {
    if (span.start <= current.end) {
      current = {
        start: current.start,
        end: Math.max(current.end, span.end),
        category:
          span.priority < current.priority ? span.category : current.category,
        matchedBy:
          span.priority < current.priority ? span.matchedBy : current.matchedBy,
        priority: Math.min(current.priority, span.priority),
      };
      continue;
    }
    merged.push(strip(current));
    current = span;
  }
  merged.push(strip(current));
  return merged;
}

function strip(span: DetectedSpan & { priority: number }): DetectedSpan {
  const { start, end, category, matchedBy } = span;
  return { start, end, category, matchedBy };
}

/**
 * Finds every contact detail in `input`, as offsets INTO `input`.
 *
 * The offsets are the product. A boolean would be enough to block a message,
 * but not to show its author which words of theirs did not go through, and that
 * is what the feature promises them.
 *
 * Deterministic, allocation-light and free: nothing here is asked of a network
 * or a model. Whatever runs after this is allowed to fail; this is not.
 */
export function detectContacts(
  input: string,
  options: DetectOptions = {},
): DetectedSpan[] {
  if (!input) return [];

  const text =
    input.length > MAX_SCAN_LENGTH ? input.slice(0, MAX_SCAN_LENGTH) : input;
  const disabled = new Set(options.disabled ?? []);

  const specs: PatternSpec[] = [...BASE_PATTERNS];
  const operator = operatorPrefixPattern(options.operatorPrefixes ?? []);
  if (operator) specs.push(operator);

  const found: (DetectedSpan & { priority: number })[] = [];
  let folded: ReturnType<typeof foldWithOffsets> | null = null;

  for (const [index, spec] of specs.entries()) {
    if (disabled.has(spec.category)) continue;

    // Priority IS the position in the list: see the ordering note on
    // BASE_PATTERNS. Lower wins when two spans overlap.
    if (spec.scope === 'raw') {
      found.push(...matchAll(text, spec, index));
      continue;
    }

    // Folded once, lazily: most messages never reach a folded pattern, and
    // folding allocates three arrays the size of the text.
    folded ??= foldWithOffsets(text);
    if (folded.text.length === 0) continue;

    for (const hit of matchAll(folded.text, spec, index)) {
      const source = toSourceSpan(folded, hit);
      found.push({ ...hit, start: source.start, end: source.end });
    }
  }

  return merge(found);
}
