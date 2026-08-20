import {
  flattenForTemplateVariable,
  sanitizeTemplateVariable,
  formatAdminMessage,
  ADMIN_MESSAGE_VAR_MAX,
} from '../admin-message';

/**
 * The flattening itself is tested at its home,
 * common/utils/__tests__/whatsapp-template-text.util.spec.ts. What matters here
 * is that it is still reachable from this path: `whatsapp.service.ts` imports it
 * from `../templates`, and a re-export dropped in a tidy-up would break that
 * import rather than any test of the function.
 */
describe('re-exports', () => {
  it('still resolves the template-text helpers', () => {
    expect(flattenForTemplateVariable('a\r\nb')).toBe('a b');
    expect(sanitizeTemplateVariable('a\r\nb')).toBe('a b');
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
   * The category is MARKETING and cannot be argued back: v2 kept UTILITY only
   * because it was signed with the admin's own name, and both nameless
   * versions were reclassified. Accepted deliberately — see the registry entry.
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
