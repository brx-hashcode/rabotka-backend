import {
  capTemplateVar,
  flattenForTemplateVariable,
  sanitizeTemplateVariable,
  FREE_TEXT_VAR_MAX,
} from '../whatsapp-template-text.util';

/**
 * What Meta polices inside a template parameter. A value failing this is what
 * error 132018 rejects the entire send over.
 */
const isAcceptableVariable = (v: string) =>
  !/[\n\t]/.test(v) && !/ {2,}/.test(v);

describe('sanitizeTemplateVariable', () => {
  it.each([
    ['CRLF', 'a\r\nb', 'a b'],
    ['lone CR', 'a\rb', 'a b'],
    ['tabs', 'a\tb', 'a b'],
    ['four spaces', 'a    b', 'a b'],
    ['single newline', 'ligne un\nligne deux', 'ligne un ligne deux'],
    [
      'paragraph break becomes a separator',
      'Bonjour,\n\nVotre dossier est validé.',
      'Bonjour, · Votre dossier est validé.',
    ],
    ['many blank lines collapse to one separator', 'a\n\n\n\n\nb', 'a · b'],
    ['leading blank lines', '\n\n\nBonjour', 'Bonjour'],
    ['trailing blank lines', 'Bonjour\n\n\n', 'Bonjour'],
    ['surrounding whitespace', '  a  \n\n  b\t\tc  ', 'a · b c'],
    ['zero-width characters are dropped', 'a​b‍b', 'abb'],
    [
      'accents and punctuation survive',
      'déjà — c’est bon ! (100%)',
      'déjà — c’est bon ! (100%)',
    ],
  ])('%s', (_label, input, expected) => {
    const out = sanitizeTemplateVariable(input);
    expect(out).toBe(expected);
    expect(isAcceptableVariable(out)).toBe(true);
  });

  /**
   * The one behavioural difference from `flattenForTemplateVariable`, and the
   * reason the two exist separately: the provider mappers call this one, and it
   * must not rewrite a value that survived flattening. Whitespace-only input
   * still comes back empty from both — the leading `.trim()` handles that before
   * either guard is reached.
   */
  it('leaves a separators-only result standing', () => {
    expect(sanitizeTemplateVariable('·\n\n·')).toBe('· · ·');
    expect(flattenForTemplateVariable('·\n\n·')).toBe('');
  });

  it.each([
    ['spaces only', '     '],
    ['blank lines only', '  \n\n \t '],
  ])('returns empty for %s, same as flatten', (_label, input) => {
    expect(sanitizeTemplateVariable(input)).toBe('');
  });
});

describe('flattenForTemplateVariable', () => {
  it('matches sanitizeTemplateVariable on text that has content', () => {
    const input = 'Bonjour,\r\n\r\nMerci de renvoyer le document.';
    expect(flattenForTemplateVariable(input)).toBe(
      sanitizeTemplateVariable(input),
    );
  });

  it.each([
    ['empty string', ''],
    ['spaces only', '     '],
    ['blank lines only', '  \n\n \t '],
    ['newlines only', '\n\n\n'],
  ])('returns empty for %s', (_label, input) => {
    // Must be empty, not a bare "·" — the caller's emptiness check is what stops
    // a whitespace-only message from being sent as a lone separator, and what
    // lets `freeTextVar` in the registry reach its French fallback.
    expect(flattenForTemplateVariable(input)).toBe('');
  });

  it('never emits a value Meta would reject, for a realistic canned message', () => {
    const canned = [
      'Bonjour Marie,',
      '',
      "Votre vérification d'identité est incomplète : il manque le verso de votre pièce.",
      '',
      'Merci de le téléverser depuis votre profil.',
      '',
      "L'équipe Rabotka",
    ].join('\n');

    const out = flattenForTemplateVariable(canned);
    expect(isAcceptableVariable(out)).toBe(true);
    expect(out).toContain('·');
  });

  /**
   * The value that actually failed in production, copied off the 132018 error.
   * An admin picked the "Selfie manquant" canned snippet and typed a sign-off
   * under it; the textarea submitted CRLF.
   */
  it('handles the reason that produced the original 132018', () => {
    const out = flattenForTemplateVariable(
      "Le selfie tenant le document d'identité n'a pas été transmis.\r\n" +
        'Merci de bien vouloir le faire.\r\n\r\n' +
        'Equipe Technique Rabotka.',
    );

    expect(isAcceptableVariable(out)).toBe(true);
    expect(out).toBe(
      "Le selfie tenant le document d'identité n'a pas été transmis. " +
        'Merci de bien vouloir le faire. · Equipe Technique Rabotka.',
    );
  });
});

describe('capTemplateVar', () => {
  it('leaves text within budget untouched', () => {
    const short = 'Document illisible.';
    expect(capTemplateVar(short)).toBe(short);
  });

  it('leaves text of exactly the budget untouched', () => {
    const exact = 'a'.repeat(FREE_TEXT_VAR_MAX);
    expect(capTemplateVar(exact)).toBe(exact);
  });

  it('truncates over-budget text to the budget, ellipsis included', () => {
    const out = capTemplateVar('mot '.repeat(400));
    expect(out.length).toBeLessThanOrEqual(FREE_TEXT_VAR_MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    // A hard cut at 22 would leave "alpha bravo charlie d…". The boundary at 19
    // is inside the last fifth of the budget, so it is taken instead.
    expect(capTemplateVar('alpha bravo charlie delta echo', 22)).toBe(
      'alpha bravo charlie…',
    );
  });

  it('falls back to a hard cut when there is no nearby boundary', () => {
    // A pasted URL, or a script that does not space its words: taking the last
    // space would throw away most of the text, so it is cut where it falls.
    const out = capTemplateVar(`court ${'x'.repeat(40)}`, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('court x')).toBe(true);
  });

  it('never leaves a trailing space before the ellipsis', () => {
    expect(capTemplateVar('alpha bravo      charlie', 14)).not.toContain(' …');
  });
});
