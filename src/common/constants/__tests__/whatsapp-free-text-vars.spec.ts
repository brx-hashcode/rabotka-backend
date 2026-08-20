import { WHATSAPP_TEMPLATES } from '../whatsapp-templates';
import { FREE_TEXT_VAR_MAX } from '../../utils/whatsapp-template-text.util';

/** What Meta rejects a send over (132018). */
const isAcceptableVariable = (v: string) =>
  !/[\n\t]/.test(v) && !/ {2,}/.test(v);

/**
 * The bindings whose value is prose somebody typed, rather than a name, a date
 * or an id this codebase produced. Each one reaches Meta as a template
 * parameter, and Meta rejects the whole send (132018) over a newline in any of
 * them — which is what a KYC rejection carrying a two-paragraph reason did.
 *
 * `build` fills the surrounding params with whatever the entry needs so only the
 * free-text one varies; `fallback` is the French string that must appear when
 * the field is blank, since a variable may never be empty (132000).
 */
const FREE_TEXT_BINDINGS = [
  {
    name: 'kycRejected.reason',
    variable: '2',
    fallback: 'Non précisé',
    build: (reason: string | null) =>
      WHATSAPP_TEMPLATES.kycRejected.variables({
        firstName: 'Marie',
        reason,
        loginCode: 'abc123',
      }),
  },
  {
    name: 'accountSuspended.reason',
    variable: '2',
    fallback: 'Non précisé',
    build: (reason: string | null) =>
      WHATSAPP_TEMPLATES.accountSuspended.variables({
        firstName: 'Marie',
        reason,
        loginCode: 'abc123',
      }),
  },
  {
    name: 'cancellation.reason',
    variable: '4',
    fallback: 'Aucune raison donnée',
    build: (reason: string | null) =>
      WHATSAPP_TEMPLATES.cancellation.variables({
        workerName: 'Marie',
        offerTitle: 'Serveuse',
        date: '12/03',
        reason: reason ?? '',
        penaltyStatus: 'Aucune pénalité',
        jobOfferId: 'offer-1',
      }),
  },
  {
    name: 'newApplication.workerDescription',
    variable: '5',
    fallback: 'Non renseignée',
    build: (description: string | null) =>
      WHATSAPP_TEMPLATES.newApplication.variables({
        offerTitle: 'Serveuse',
        workerName: 'Marie',
        reliabilityScore: 4,
        completedMissions: 12,
        workerDescription: description ?? '',
        scheduledAt: '12/03',
        address: 'Brazzaville',
        applicationId: 'app-1',
      }),
  },
] as const;

describe.each(FREE_TEXT_BINDINGS)('$name', ({ variable, fallback, build }) => {
  /**
   * The exact value that failed in production, copied off the 132018 error.
   * The CRLF comes from the admin's textarea — browsers normalise line breaks
   * to CRLF on submit, so it is not an exotic input.
   */
  const PRODUCTION_FAILURE =
    "Le selfie tenant le document d'identité n'a pas été transmis.\r\n" +
    'Merci de bien vouloir le faire.\r\n\r\n' +
    'Equipe Technique Rabotka.';

  it.each([
    ['the reason that produced the original 132018', PRODUCTION_FAILURE],
    ['CRLF', 'ligne un\r\nligne deux'],
    ['tabs', 'colonne\tcolonne'],
    ['runs of spaces', 'espace' + ' '.repeat(6) + 'espace'],
    ['zero-width characters pasted from a browser', 'a​b‍c'],
  ])('emits a value Meta accepts for %s', (_label, input) => {
    const value = build(input)[variable];
    expect(isAcceptableVariable(value)).toBe(true);
  });

  it('keeps the text readable rather than merely legal', () => {
    const value = build(PRODUCTION_FAILURE)[variable];
    // The paragraph break survives as a visible separator; flattening with
    // plain spaces alone produces an unreadable run-on.
    expect(value).toContain('·');
    expect(value).toContain('Equipe Technique Rabotka.');
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace', '   '],
    // The case a bare `.trim()` check let through before: non-empty as typed,
    // empty once flattened, so it arrived blank and drew a 132000.
    ['CRLF only', '\r\n\r\n'],
  ])('falls back for %s', (_label, input) => {
    expect(build(input)[variable]).toBe(fallback);
  });

  it('caps an over-long value inside Meta’s body budget', () => {
    const value = build('mot '.repeat(500))[variable];
    expect(value.length).toBeLessThanOrEqual(FREE_TEXT_VAR_MAX);
    expect(value.endsWith('…')).toBe(true);
  });
});
