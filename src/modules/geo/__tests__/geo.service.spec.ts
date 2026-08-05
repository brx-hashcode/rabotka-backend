import { NotFoundException } from '@nestjs/common';
import { GeoService } from '../geo.service';

/**
 * Runs against the real checked-in dataset, not a fixture. The point of that
 * file is that it ships with the image and is always available — a mock here
 * would test the mock and leave a corrupt or missing dataset to be discovered
 * in production, during someone's signup.
 */
describe('GeoService', () => {
  const geo = new GeoService();

  it('serves a complete country list, sorted for a French reader', () => {
    const countries = geo.listCountries();
    expect(countries.length).toBeGreaterThan(200);

    const names = countries.map((c) => c.name);
    expect([...names].sort((a, b) => a.localeCompare(b, 'fr'))).toEqual(names);
    expect(countries.every((c) => /^[A-Z]{2}$/.test(c.code))).toBe(true);
  });

  it('knows the home market', () => {
    expect(geo.findCountry('CG')).toEqual({
      code: 'CG',
      name: 'Congo-Brazzaville',
    });
    // The dataset drops to a 500-inhabitant floor for Congo, so real towns are
    // selectable and not just the two big cities.
    const cities = geo.listCities('CG');
    expect(cities).toContain('Brazzaville');
    expect(cities).toContain('Pointe-Noire');
    expect(cities.length).toBeGreaterThan(30);
  });

  it('accepts a country code in any case', () => {
    expect(geo.findCountry('cg')?.code).toBe('CG');
    expect(geo.findCountry(' Cg ')?.code).toBe('CG');
  });

  it('returns null rather than throwing for an absent code', () => {
    expect(geo.findCountry(null)).toBeNull();
    expect(geo.findCountry('')).toBeNull();
    expect(geo.findCountry('ZZ')).toBeNull();
  });

  it('404s an unknown country but not a country with no cities', () => {
    expect(() => geo.listCities('ZZ')).toThrow(NotFoundException);

    // A real country the dataset has no populated places for must read as
    // "no cities", not "no such country" — otherwise the picker tells someone
    // their own country does not exist.
    const empty = geo
      .listCountries()
      .find((c) => geo.listCities(c.code).length === 0);
    expect(empty).toBeDefined();
    expect(geo.listCities(empty!.code)).toEqual([]);
  });

  describe('canonicalCity()', () => {
    it('snaps a match to the dataset spelling', () => {
      expect(geo.canonicalCity('CG', '  brazzaville ')).toBe('Brazzaville');
      expect(geo.canonicalCity('cg', 'POINTE-NOIRE')).toBe('Pointe-Noire');
    });

    it('passes an unknown city through instead of rejecting it', () => {
      // Deliberate: city names change between dataset refreshes, and a user
      // whose stored city was renamed upstream must still be able to save.
      expect(geo.canonicalCity('CG', 'Village Inconnu')).toBe(
        'Village Inconnu',
      );
      expect(geo.canonicalCity(null, '  Ailleurs ')).toBe('Ailleurs');
    });
  });
});
