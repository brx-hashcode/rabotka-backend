/**
 * Accent- and case-folding that REMEMBERS WHERE EVERY CHARACTER CAME FROM.
 *
 * `foldText` (`rag/shared/text.ts`) already folds, and it is used everywhere in
 * the RAG module, but it cannot be used here: it decomposes, drops combining
 * marks, lowercases, turns punctuation into spaces and collapses runs — five
 * steps, four of which change string lengths. An offset found in its output
 * designates nothing in the input, so a match cannot be reported back to the
 * person who typed it.
 *
 * That matters because the sender has to see EXACTLY which fragment of their
 * own message was withheld, on the right characters. A "something was removed"
 * banner is a different, worse product.
 *
 * `foldText` is deliberately left alone. It has callers that depend on its
 * current shape and rewriting it in terms of this file is a refactor for
 * another day.
 *
 * WHEN YOU ACTUALLY NEED THIS: less often than it looks. Phone numbers, emails,
 * URLs and handles are matched on the RAW text — `GuardService.sanitize` does
 * the same, running its phone patterns before it folds anything — because
 * folding would eat the `+`, the dots and the dashes those patterns are built
 * around. Only the word-shaped family ("zero six douze") needs folding, and it
 * is the only caller here.
 */

/** Combining marks, i.e. what NFD splits an accented letter into. */
const COMBINING = /\p{M}/gu;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

export interface FoldedText {
  /** Folded text: no accents, lower case, punctuation and runs collapsed to one space. */
  readonly text: string;
  /** `start[i]` — UTF-16 index in the source of the character that produced `text[i]`. */
  readonly start: Int32Array;
  /** `end[i]` — exclusive UTF-16 end of that same source character. */
  readonly end: Int32Array;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Folds `input` and records, per output character, the slice of the input it
 * came from.
 *
 * Two arrays rather than one: a source character can be two UTF-16 units wide
 * (anything outside the BMP), so "where it ended" is not "where it started plus
 * one". Storing the end is cheaper than re-measuring the source at read time
 * and impossible to get subtly wrong later.
 *
 * Invariant, asserted in the tests: `text.length === start.length === end.length`.
 */
export function foldWithOffsets(input: string): FoldedText {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < input.length; ) {
    const codePoint = input.codePointAt(i)!;
    const source = String.fromCodePoint(codePoint);
    const width = source.length;
    const sourceEnd = i + width;

    // Decomposing ONE source character at a time is what keeps the mapping
    // honest: NFD on the whole string would split an accented letter into two
    // output positions with no way back to the single input position.
    const stripped = source.normalize('NFD').replace(COMBINING, '').toLowerCase();

    for (const char of stripped) {
      if (ALPHANUMERIC.test(char)) {
        out.push(char);
        // One entry PER UTF-16 UNIT, not per character, or the arrays fall out
        // of step with the string the moment a non-BMP letter appears.
        for (let unit = 0; unit < char.length; unit++) {
          starts.push(i);
          ends.push(sourceEnd);
        }
        pendingSpace = false;
      } else if (!pendingSpace && out.length > 0) {
        // Punctuation, whitespace, emoji — all one separator, runs collapsed.
        // `out.length > 0` drops leading separators, which is the `trim()` that
        // `foldText` does at the end.
        out.push(' ');
        starts.push(i);
        ends.push(sourceEnd);
        pendingSpace = true;
      }
    }

    i += width;
  }

  // Trailing separator: the other half of the trim.
  while (out.length > 0 && out[out.length - 1] === ' ') {
    out.pop();
    starts.pop();
    ends.pop();
  }

  return {
    text: out.join(''),
    start: Int32Array.from(starts),
    end: Int32Array.from(ends),
  };
}

/**
 * Turns a span of the folded text back into a span of the source.
 *
 * Half-open on both sides, like everything else here. A span whose bounds are
 * outside the folded text is a caller bug and throws rather than returning a
 * plausible-looking wrong answer — a silently shifted offset would redact the
 * wrong characters of someone's message.
 */
export function toSourceSpan(folded: FoldedText, span: Span): Span {
  const { start, end } = span;
  if (start < 0 || end > folded.text.length || start >= end) {
    throw new RangeError(
      `Span [${start}, ${end}) is not inside a folded text of length ${folded.text.length}`,
    );
  }
  return { start: folded.start[start], end: folded.end[end - 1] };
}
