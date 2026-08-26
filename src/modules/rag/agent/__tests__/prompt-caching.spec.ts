import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import {
  buildAnonymousSystemPromptParts,
  buildSystemPrompt,
  buildSystemPromptParts,
} from '../prompts';

/**
 * The stable/volatile seam, which nothing else in the suite can defend.
 *
 * Prompt caching is a PREFIX match: the first byte that changes between two
 * turns invalidates everything after it. So the property that matters is not
 * "the prompt contains X" — every other prompt spec already asserts that — but
 * "the stable half is byte-identical across turns that differ only in who is
 * asking and when".
 *
 * That property is invisible to a `toContain` assertion, and it breaks silently:
 * a name or a clock reading moved back into the stable block costs nothing at
 * build time, passes every existing test, and quietly takes the cache hit rate
 * to zero. These tests exist to make that loud.
 */
const base = {
  firstName: 'Marie',
  profileType: ProfileType.WORKER,
  verificationStatus: VerificationStatus.VERIFIED,
  accountStatus: AccountStatus.ACTIVE,
  categorySlugs: ['plomberie'],
  grounding: [],
  requiredTools: [],
  language: 'fr' as const,
};

describe('prompt caching — the stable half', () => {
  it('is identical across two turns that differ in name, time and corpus', () => {
    const morning = buildSystemPromptParts({
      ...base,
      now: new Date('2026-08-26T08:00:00Z'),
    });
    const evening = buildSystemPromptParts({
      ...base,
      firstName: 'Jean',
      now: new Date('2026-08-26T19:00:00Z'),
      categorySlugs: ['coiffure', 'couture'],
      grounding: [{ title: 'Tarifs', section: 'Déblocage', text: '100 FCFA' }],
      requiredTools: ['tarif_deblocage'],
      verificationStatus: VerificationStatus.PENDING,
      accountStatus: AccountStatus.SUSPENDED,
    });

    expect(evening.stable).toBe(morning.stable);
    // …and the half that was supposed to absorb all of that actually did.
    expect(evening.volatile).not.toBe(morning.volatile);
  });

  it('carries none of the values that change per turn', () => {
    // A sentinel name, NOT « Marie » — the bold-formatting rule carries a
    // literal « Bonjour *Marie* » as its example, which is stable prompt text
    // and must stay put. Asserting on that name would confuse the fixed example
    // with the interpolated value and fail for the wrong reason.
    const { stable } = buildSystemPromptParts({
      ...base,
      firstName: 'Zéphyrine',
      now: new Date('2026-08-26T19:30:00Z'),
      categorySlugs: ['soudure-industrielle'],
      grounding: [
        { title: 'Tarifs', section: 'Déblocage', text: 'CORPUS-EXTRAIT' },
      ],
    });

    expect(stable).not.toContain('Zéphyrine');
    expect(stable).not.toContain('19h30');
    expect(stable).not.toContain('Brazzaville');
    expect(stable).not.toContain('CORPUS-EXTRAIT');
    expect(stable).not.toContain('soudure-industrielle');
  });

  it('clears the ~1024-token floor a cacheable prefix needs', () => {
    // Below the minimum, a prefix is silently NOT cached — no error, no
    // warning, just a hit rate of zero. French runs ~3 characters per token,
    // and this asserts the conservative 3.5 still clears it with room to spare.
    const { stable } = buildSystemPromptParts(base);
    expect(stable.length / 3.5).toBeGreaterThan(1500);
  });

  it('still splits per language and per profile type', () => {
    // Two variants each — which is fine, that is four cache entries, not a
    // broken prefix. What would NOT be fine is these coming out identical:
    // it would mean the language directive or the role rules had been dropped.
    const fr = buildSystemPromptParts(base).stable;
    const en = buildSystemPromptParts({ ...base, language: 'en' }).stable;
    const employer = buildSystemPromptParts({
      ...base,
      profileType: ProfileType.EMPLOYER,
    }).stable;

    expect(en).not.toBe(fr);
    expect(employer).not.toBe(fr);
  });

  it('loses no line when the two halves are rejoined', () => {
    // The split moved lines; it must not have dropped any. Anything that was
    // in the prompt before is still in it, wherever it now sits.
    const whole = buildSystemPrompt({
      ...base,
      verificationStatus: VerificationStatus.REJECTED,
      accountStatus: AccountStatus.SUSPENDED,
      grounding: [{ title: 'KYC', section: 'Refus', text: 'les étapes' }],
    });

    for (const line of [
      'Tu es VoVa AI',
      'Rends la salutation EN PREMIER',
      'Bonsoir *Marie* !',
      'Tu parles à Marie, travailleur',
      'à Brazzaville',
      '## Ce que tu mets en gras',
      '## Ton ton',
      'REFUSÉE',
      'Ce compte est SUSPENDU',
      'Documentation Rabotka',
      "si on te demande QUI ou CE QUE TU ES",
    ]) {
      expect(whole).toContain(line);
    }
  });

  it('keeps the greeting rule ahead of the thanks rule', () => {
    // Load-bearing precedence, and the one thing the reordering could plausibly
    // have broken. « bonsoir, merci » matched the thanks rule first and fell
    // through the greeting one, so nobody got their bonsoir returned.
    const whole = buildSystemPrompt(base);
    expect(whole.indexOf('Rends la salutation EN PREMIER')).toBeLessThan(
      whole.indexOf('On te remercie ?'),
    );
  });

  it('points at the documentation in the direction it now sits', () => {
    // The corpus moved below these rules, so a « ci-dessus » left behind would
    // send the model looking for something that is no longer there.
    const employer = buildSystemPrompt({
      ...base,
      profileType: ProfileType.EMPLOYER,
      grounding: [{ title: 'Publier', section: 'Champs', text: 'le budget' }],
    });

    expect(employer).toContain('de la documentation plus bas');
    expect(employer).not.toContain('de la documentation ci-dessus');
    // The REJECTED line is the mirror case: it sits AFTER the corpus, so its
    // « ci-dessus » is still the truth and must not have been "fixed" too.
    const rejected = buildSystemPrompt({
      ...base,
      verificationStatus: VerificationStatus.REJECTED,
      grounding: [{ title: 'KYC', section: 'Refus', text: 'les étapes' }],
    });
    expect(rejected).toContain('la documentation ci-dessus donne les étapes');
  });
});

describe('prompt caching — the anonymous prompt', () => {
  it('holds the clock and the corpus out of the stable half', () => {
    const first = buildAnonymousSystemPromptParts({
      grounding: [],
      language: 'fr',
      now: new Date('2026-08-26T08:00:00Z'),
    });
    const later = buildAnonymousSystemPromptParts({
      grounding: [{ title: 'Tarifs', section: 'A', text: 'ANON-EXTRAIT' }],
      language: 'fr',
      now: new Date('2026-08-26T19:00:00Z'),
    });

    expect(later.stable).toBe(first.stable);
    expect(first.stable).not.toContain('Brazzaville');
    expect(later.stable).not.toContain('ANON-EXTRAIT');
    expect(later.volatile).toContain('ANON-EXTRAIT');
  });

  it('points at the clock in the direction it now sits', () => {
    const { stable } = buildAnonymousSystemPromptParts({
      grounding: [],
      language: 'fr',
    });
    expect(stable).toContain("l'heure indiquée plus bas");
    expect(stable).not.toContain("l'heure indiquée plus haut");
  });
});
