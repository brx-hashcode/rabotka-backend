import { expandQuery } from '../aliases';

describe('expandQuery', () => {
  it('adds the product word when the user uses the street word', () => {
    expect(expandQuery('je cherche un boulot')).toContain('mission');
    expect(expandQuery('je veux un job')).toContain('offre');
  });

  // The dense leg shrugs at accents; the sparse leg does not — «pénalités» and
  // «penalites» are different tokens, so both forms have to be in the query.
  it('adds the accent-folded form so the lexical leg matches either spelling', () => {
    expect(expandQuery('mes pénalités')).toContain('penalites');
    expect(expandQuery('mes pénalités')).toContain('pénalités');
    expect(expandQuery('déblocage')).toContain('deblocage');
  });

  it('does not add a folded form when there is nothing to fold', () => {
    expect(expandQuery('bonjour')).toBe('bonjour');
  });

  it('bridges everyday words to the mechanisms', () => {
    expect(expandQuery('je veux son numero')).toContain('deblocage');
    expect(expandQuery('comment payer par momo')).toContain('mobile money');
    expect(expandQuery("j'ai un probleme")).toContain('reclamation');
    expect(expandQuery('mes papiers')).toContain('kyc');
  });

  // The user's own words are the strongest signal — expansion never replaces.
  it('keeps the original query intact', () => {
    const out = expandQuery('je cherche un boulot de plombier');
    expect(out.startsWith('je cherche un boulot de plombier')).toBe(true);
  });

  it('does not repeat a term the query already contains', () => {
    const out = expandQuery('je cherche une mission, un boulot');
    expect(out.match(/mission/g)).toHaveLength(1);
  });

  /**
   * The recruiter's intent.
   *
   * « Je veux créer un job » retrieved the PORTFOLIO article and logged a gap.
   * `job` alone expands to mission/travail/offre — all worker vocabulary —
   * while the article that answers it is written around *publier* and
   * *annonce*, so nothing connected the question to it.
   */
  describe('publishing', () => {
    it('reaches the publishing vocabulary from « créer un job »', () => {
      const out = expandQuery('je veux créer un job');
      expect(out).toContain('publier');
      expect(out).toContain('annonce');
    });

    it('does the same for the other ways of saying it', () => {
      for (const q of [
        'je veux créer une offre',
        'créer une mission',
        'je veux recruter',
        'je veux embaucher quelqu’un',
        'comment poster une annonce',
      ]) {
        expect(expandQuery(q)).toContain('publier');
      }
    });

    it('does NOT hijack « créer un compte »', () => {
      // The verb is ambiguous, which is why the triggers are multi-word:
      // signing up is a different article entirely.
      const out = expandQuery('je veux créer un compte');
      expect(out).not.toContain('publier');
      expect(out).not.toContain('annonce');
    });
  });

  it('leaves a query with no trigger untouched', () => {
    expect(expandQuery('bonjour')).toBe('bonjour');
    expect(expandQuery('')).toBe('');
  });
});
