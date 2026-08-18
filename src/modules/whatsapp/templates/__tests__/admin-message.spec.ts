import {
  flattenForTemplateVariable,
  formatAdminMessage,
  ADMIN_MESSAGE_VAR_MAX,
} from '../admin-message';

describe('flattenForTemplateVariable', () => {
  // Meta rejects a template variable containing any of these.
  const isAcceptableVariable = (v: string) =>
    !/[\n\t]/.test(v) && !/ {2,}/.test(v);

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
    ['accents and punctuation survive', 'déjà — c’est bon ! (100%)', 'déjà — c’est bon ! (100%)'],
  ])('%s', (_label, input, expected) => {
    const out = flattenForTemplateVariable(input);
    expect(out).toBe(expected);
    expect(isAcceptableVariable(out)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['spaces only', '     '],
    ['blank lines only', '  \n\n \t '],
    ['newlines only', '\n\n\n'],
  ])('returns empty for %s', (_label, input) => {
    // Must be empty, not a bare "·" — the caller's emptiness check is what stops
    // a whitespace-only message from being sent as a lone separator.
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
});

describe('formatAdminMessage', () => {
  /**
   * GOLDEN STRING — the approved body of `rabotka_admin_message_v4`, authored
   * in `scripts/whatsapp-templates/definitions.ts`, with {{1}} substituted.
   *
   * If this test fails, either the local renderer drifted from the approved
   * template or someone changed the template body. An approved WhatsApp body
   * cannot be edited: a wording change means a NEW version, so update the
   * payload in `definitions.ts`, resubmit with `create.ts`, wait for the
   * verdict, then change this expectation to match.
   *
   * Watch the category on that verdict. v3 was approved but reclassified
   * UTILITY -> MARKETING, which bills higher and honours marketing opt-out;
   * the opening line here is what carries the utility signal.
   */
  it('renders exactly the approved template body', () => {
    expect(
      formatAdminMessage({
        message: 'Votre compte est maintenant actif.',
      }),
    ).toBe(
      '*Rabotka*\n' +
        '\n' +
        'Message de notre équipe support concernant votre compte :\n' +
        '\n' +
        'Votre compte est maintenant actif.\n' +
        '\n' +
        'Merci et à bientôt,\n' +
        '_L’équipe Rabotka_',
    );
  });

  it('opens and closes on static text, as Meta requires of the template', () => {
    const body = formatAdminMessage({ message: 'x' });
    // A template body may neither start nor end with a variable (subCode
    // 2388299); the rendered body must show the same shape.
    expect(body.startsWith('*Rabotka*')).toBe(true);
    expect(body.endsWith('L’équipe Rabotka_')).toBe(true);
  });

  it('carries enough static text for Meta’s variable-density rule', () => {
    // The v1 body had ~27 static chars around two variables and was rejected
    // with subCode 2388293, "too many variables for its length". Guard the
    // budget so a future trim does not silently walk back into that.
    const staticChars = formatAdminMessage({ message: '' }).replace(
      /\s/g,
      '',
    ).length;
    expect(staticChars).toBeGreaterThanOrEqual(40);
  });
});

describe('constants', () => {
  it('caps the variable well inside Meta’s 1024-char body limit', () => {
    const staticOverhead = formatAdminMessage({ message: '' }).length;
    expect(ADMIN_MESSAGE_VAR_MAX + staticOverhead).toBeLessThan(1024);
  });
});
