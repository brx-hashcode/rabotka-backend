import { countryOfPhone, toAlpha3 } from '../payment-countries';

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

describe('countryOfPhone', () => {
  it('reads the country from an international prefix', () => {
    expect(countryOfPhone('+242 06 123 4567')).toBe('COG');
    expect(countryOfPhone('00237677123456')).toBe('CMR');
  });

  it('knows nothing of a local number or an unlisted country', () => {
    expect(countryOfPhone('061234567')).toBeNull();
    expect(countryOfPhone('+33612345678')).toBeNull();
    expect(countryOfPhone(null)).toBeNull();
  });
});
