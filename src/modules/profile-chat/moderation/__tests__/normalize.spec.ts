import { foldWithOffsets, toSourceSpan } from '../normalize';

/**
 * The offset table is the one thing here that fails INVISIBLY. A wrong pattern
 * shows up as a message that should have been caught and wasn't; a wrong table
 * shows up as somebody's sentence with a hole in the wrong place, which nobody
 * reports because it reads as a bug in the app rather than in the filter.
 *
 * So the invariants are checked over generated input, not just examples.
 */
describe('foldWithOffsets', () => {
  it('folds accents, case and punctuation like the RAG folder does', () => {
    expect(foldWithOffsets('Héllo,   MONDE!').text).toBe('hello monde');
  });

  it.each([
    ['', ''],
    ['   ', ''],
    ['...', ''],
    ['a', 'a'],
    ['  leading', 'leading'],
    ['trailing  ', 'trailing'],
    ['a...b', 'a b'],
  ])('handles %p', (input, expected) => {
    expect(foldWithOffsets(input).text).toBe(expected);
  });

  it('treats a precomposed and a decomposed accent identically', () => {
    const precomposed = foldWithOffsets('é').text;
    const decomposed = foldWithOffsets('é').text;
    expect(precomposed).toBe('e');
    expect(decomposed).toBe('e');
  });

  it('does not let a non-BMP character shift the table', () => {
    // An emoji is two UTF-16 units. If the arrays were written once per
    // character rather than once per unit, every offset after it would be off
    // by one — and every test using short ASCII strings would still pass.
    const folded = foldWithOffsets('06 🎉 douze');
    expect(folded.text.length).toBe(folded.start.length);
    expect(folded.text.length).toBe(folded.end.length);

    const at = folded.text.indexOf('douze');
    const span = toSourceSpan(folded, { start: at, end: at + 5 });
    expect('06 🎉 douze'.slice(span.start, span.end)).toBe('douze');
  });

  it('maps a span back onto the exact source characters', () => {
    const source = 'Appelle-moi: ZÉRO-six!!';
    const folded = foldWithOffsets(source);

    const at = folded.text.indexOf('zero six');
    const span = toSourceSpan(folded, { start: at, end: at + 'zero six'.length });

    expect(source.slice(span.start, span.end)).toBe('ZÉRO-six');
  });

  it('refuses a span that is not inside the folded text', () => {
    const folded = foldWithOffsets('court');
    expect(() => toSourceSpan(folded, { start: 0, end: 99 })).toThrow(
      RangeError,
    );
    expect(() => toSourceSpan(folded, { start: 2, end: 2 })).toThrow(RangeError);
  });

  describe('invariants, over generated input', () => {
    const ALPHABET = [
      'a',
      'é',
      'E',
      '9',
      ' ',
      '.',
      '-',
      '+',
      '@',
      '́',
      '🎉',
      '\n',
      'ß',
    ];

    // Deterministic: a seeded sequence, so a failure is reproducible rather
    // than a flake somebody reruns until it passes.
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    const samples = Array.from({ length: 500 }, () => {
      const length = Math.floor(next() * 30);
      return Array.from(
        { length },
        () => ALPHABET[Math.floor(next() * ALPHABET.length)],
      ).join('');
    });

    it('keeps the two tables the same length as the text', () => {
      for (const sample of samples) {
        const folded = foldWithOffsets(sample);
        expect(folded.start.length).toBe(folded.text.length);
        expect(folded.end.length).toBe(folded.text.length);
      }
    });

    it('only ever points inside the source, and forward', () => {
      for (const sample of samples) {
        const folded = foldWithOffsets(sample);
        let previous = -1;
        for (let i = 0; i < folded.text.length; i++) {
          expect(folded.start[i]).toBeGreaterThanOrEqual(0);
          expect(folded.end[i]).toBeLessThanOrEqual(sample.length);
          expect(folded.end[i]).toBeGreaterThan(folded.start[i]);
          // Non-decreasing: folding never reorders.
          expect(folded.start[i]).toBeGreaterThanOrEqual(previous);
          previous = folded.start[i];
        }
      }
    });

    it('never produces a leading, trailing or doubled space', () => {
      for (const sample of samples) {
        const { text } = foldWithOffsets(sample);
        expect(text).not.toMatch(/^ | $|  /);
      }
    });
  });
});
