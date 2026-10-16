import { toAlpha3 } from '../payment-countries';

describe('toAlpha3', () => {
  it.each([
    ['CG', 'COG'],
    ['cm', 'CMR'],
    [' CG ', 'COG'],
  ])('maps %s to %s', (alpha2, alpha3) => {
    expect(toAlpha3(alpha2)).toBe(alpha3);
  });

  it('returns null for a country no gateway covers, or none', () => {
    expect(toAlpha3('FR')).toBeNull();
    expect(toAlpha3(null)).toBeNull();
    expect(toAlpha3('')).toBeNull();
  });
});
