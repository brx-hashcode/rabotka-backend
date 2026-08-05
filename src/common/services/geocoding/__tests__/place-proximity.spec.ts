import {
  GEO_MATCH_SCORE,
  placeProximityScore,
  proximityScore,
} from '../geo.utils';

/**
 * The fallback the proximity term uses when either side has no coordinates.
 *
 * Before this existed the answer was always 0.5 — and `prox` carries the
 * heaviest cold-start weight (0.35), so for anyone whose fire-and-forget
 * geocoding had failed, a third of their ranking was a constant that ordered
 * nothing. Every ordering below is what makes it order something.
 */
describe('placeProximityScore()', () => {
  const cg = (city: string | null) => ({ countryCode: 'CG', city });

  it('ranks same city above same country above a different country', () => {
    const sameCity = placeProximityScore(cg('Brazzaville'), cg('Brazzaville'));
    const sameCountry = placeProximityScore(
      cg('Brazzaville'),
      cg('Pointe-Noire'),
    );
    const abroad = placeProximityScore(cg('Brazzaville'), {
      countryCode: 'FR',
      city: 'Paris',
    });

    expect(sameCity).toBeGreaterThan(sameCountry);
    expect(sameCountry).toBeGreaterThan(abroad);
    expect(abroad).toBeGreaterThan(0);
  });

  it('stays below what a real nearby coordinate pair scores', () => {
    // The ordering that keeps the fallback honest: "same city" is a weaker
    // claim than "800 m away" and must never outrank it, or a geocoded
    // neighbour would lose to someone merely in the same city.
    expect(GEO_MATCH_SCORE.SAME_CITY).toBeLessThan(proximityScore(0.8));
  });

  it('is the old neutral 0.5 when either side declared no country', () => {
    // Not a regression guard for its own sake: this is the case that must NOT
    // change, because a profile that has told us nothing is exactly as
    // informative as it was before.
    expect(placeProximityScore(cg('Brazzaville'), cg('Brazzaville'))).not.toBe(
      0.5,
    );
    expect(
      placeProximityScore(cg('Brazzaville'), { countryCode: null, city: null }),
    ).toBe(0.5);
    expect(
      placeProximityScore(
        { countryCode: undefined, city: undefined },
        cg(null),
      ),
    ).toBe(0.5);
  });

  it('falls back to country level when a city is missing on either side', () => {
    // The backfill leaves city null for every existing profile, so this is the
    // common case on the day this ships, not an edge case.
    expect(placeProximityScore(cg('Brazzaville'), cg(null))).toBe(
      GEO_MATCH_SCORE.SAME_COUNTRY,
    );
    expect(placeProximityScore(cg(null), cg(null))).toBe(
      GEO_MATCH_SCORE.SAME_COUNTRY,
    );
  });

  it('compares case- and whitespace-insensitively', () => {
    // Cities are canonicalised on write, but rows written before that ran (and
    // any admin edit) can carry either spelling.
    expect(
      placeProximityScore(cg('  brazzaville '), {
        countryCode: 'cg',
        city: 'BRAZZAVILLE',
      }),
    ).toBe(GEO_MATCH_SCORE.SAME_CITY);
  });

  it('does not treat the same city name in two countries as a match', () => {
    expect(
      placeProximityScore(
        { countryCode: 'CG', city: 'Boma' },
        { countryCode: 'CD', city: 'Boma' },
      ),
    ).toBe(GEO_MATCH_SCORE.DIFFERENT_COUNTRY);
  });
});
