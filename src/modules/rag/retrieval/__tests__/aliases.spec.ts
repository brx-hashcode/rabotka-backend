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

  it('leaves a query with no trigger untouched', () => {
    expect(expandQuery('bonjour')).toBe('bonjour');
    expect(expandQuery('')).toBe('');
  });
});
