import { PROFILE_STATE } from '../dto';
import { NEVER_EXPOSE, project } from '../projections';

/**
 * The projection has to name fields the SOURCE actually carries.
 *
 * `project()` skips an absent field without a word — no log, no throw — so a
 * projection can drift away from its DTO and go on returning almost nothing.
 * That is exactly what happened: `PROFILE_STATE` was written in snake_case
 * against `ProfileService.findById`, which returns a camelCase
 * `ProfileMeResponse`. Fourteen of seventeen entries were dropped on every
 * call, while `etat_du_profil`'s description kept promising the model a
 * verification status, a reliability score, categories and a refusal reason.
 *
 * A sample of the DTO rather than the type: the assertion has to run.
 */
const PROFILE_ME_SHAPE = {
  id: 'p-1',
  firstName: 'Awa',
  lastName: 'Ndiaye',
  email: 'awa@example.com',
  phone: '+242069917686',
  address: 'Brazzaville',
  countryCode: 'CG',
  countryName: 'Congo',
  city: 'Brazzaville',
  description: 'Électricienne',
  profileType: 'WORKER',
  status: 'SUSPENDED',
  verificationStatus: 'REJECTED',
  rejectionReason: 'Pièce illisible',
  suspensionReason: 'Comportement signalé',
  reliabilityScore: 90,
  whatsappConnected: true,
  avatarUrl: null,
  firstLogin: false,
  createdAt: new Date(),
  jobOffersCount: 0,
  applicationsCount: 2,
  penaltiesCount: 0,
  unpaidPenaltiesCount: 0,
  walletBalance: 500,
  categoryIds: ['c-1'],
  categoryNames: ['Électricité'],
};

describe('PROFILE_STATE', () => {
  it('names only fields ProfileMeResponse actually carries', () => {
    const missing = PROFILE_STATE.owner.filter(
      (field) => !(field in PROFILE_ME_SHAPE),
    );
    expect(missing).toEqual([]);
  });

  it('shows nothing at all to a public audience', () => {
    expect(PROFILE_STATE.public).toEqual([]);
    expect(project(PROFILE_ME_SHAPE, PROFILE_STATE, 'public', 'x')).toEqual({});
  });
});

describe('le motif, au propriétaire', () => {
  const owned = () =>
    project(PROFILE_ME_SHAPE, PROFILE_STATE, 'owner', 'PROFILE_STATE');

  /**
   * The point of the change. Both strings had already reached this user on
   * WhatsApp — they fill {{2}} of the refusal and suspension templates — and
   * `NEVER_EXPOSE` stopped the assistant repeating them, which is the one
   * question those users come back to ask.
   */
  it('donne le motif de refus et le motif de suspension', () => {
    expect(owned()).toMatchObject({
      rejectionReason: 'Pièce illisible',
      suspensionReason: 'Comportement signalé',
    });
  });

  it('ne les cache plus derrière la liste de blocage', () => {
    expect(NEVER_EXPOSE.has('rejection_reason')).toBe(false);
    expect(NEVER_EXPOSE.has('suspension_reason')).toBe(false);
  });

  // The rest of the blocklist is a different category — credentials and other
  // people's data — and stays exactly where it is.
  it.each([
    'phone',
    'email',
    'otp',
    'national_id',
    'document_url',
    'selfie_url',
    'access_token',
  ])('bloque toujours %s', (field) => {
    expect(NEVER_EXPOSE.has(field)).toBe(true);
  });

  // Restored by the casing fix, not by the blocklist change: these were being
  // dropped silently while the tool told the model to rely on them.
  it('rend enfin les champs que l’outil promet au modèle', () => {
    expect(owned()).toMatchObject({
      verificationStatus: 'REJECTED',
      reliabilityScore: 90,
      categoryNames: ['Électricité'],
      firstName: 'Awa',
    });
  });

  it('ne laisse pas fuir le téléphone ni l’email du propriétaire', () => {
    const out = owned() ?? {};
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('email');
  });
});
