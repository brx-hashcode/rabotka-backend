import { NotFoundException } from '@nestjs/common';
import { GeoService } from '../geo.service';
import { AFRICAN_COUNTRY_CODES, PRIORITY_REGION } from '../africa';

/**
 * Runs against the real checked-in dataset, not a fixture. The point of that
 * file is that it ships with the image and is always available — a mock here
 * would test the mock and leave a corrupt or missing dataset to be discovered
 * in production, during someone's signup.
 */
describe('GeoService', () => {
  const geo = new GeoService();

  it('offers Africa only, with West and Central Africa first', () => {
    const countries = geo.listCountries();
    const codes = countries.map((c) => c.code);

    // The dataset holds 252; the pickers used to list every one, so an
    // employer hiring in Brazzaville scrolled past Afghanistan first.
    expect(countries.length).toBeLessThan(80);
    expect(countries.every((c) => AFRICAN_COUNTRY_CODES.has(c.code))).toBe(
      true,
    );
    expect(codes).not.toContain('FR');
    expect(codes).not.toContain('AF');

    // The region the platform works in sorts above the rest of the continent,
    // and nothing from outside it is mixed in.
    const firstOther = codes.findIndex((c) => !PRIORITY_REGION.has(c));
    expect(firstOther).toBe(PRIORITY_REGION.size);
    expect(
      codes.slice(0, firstOther).every((c) => PRIORITY_REGION.has(c)),
    ).toBe(true);

    // Each group still reads alphabetically for a French speaker.
    for (const group of [codes.slice(0, firstOther), codes.slice(firstOther)]) {
      const names = group.map((c) => geo.findCountry(c)!.name);
      expect([...names].sort((a, b) => a.localeCompare(b, 'fr'))).toEqual(
        names,
      );
    }
    expect(countries.every((c) => /^[A-Z]{2}$/.test(c.code))).toBe(true);
  });

  it('narrows what is OFFERED, never what is accepted', () => {
    // A profile created before this narrowing keeps its country, and a filter
    // on it keeps matching. Refusing a stored value would be data loss.
    expect(geo.findCountry('FR')).not.toBeNull();
    expect(geo.listCities('FR').length).toBeGreaterThan(0);
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
    // their own country does not exist. Every AFRICAN country has cities, so
    // this is checked against the wider dataset rather than the offered list.
    const empty = ['AQ', 'BV', 'HM', 'UM'].find(
      (code) => geo.findCountry(code) && geo.listCities(code).length === 0,
    );
    expect(empty).toBeDefined();
    expect(geo.listCities(empty!)).toEqual([]);
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
