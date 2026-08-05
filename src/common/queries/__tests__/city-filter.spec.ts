import { cityFilter, withCityFilter } from '../city-filter';

/**
 * The city filter used by job search and worker search.
 *
 * It matches the structured column AND the free-text address on purpose. The
 * column alone would hide every row created before the backfill — which is most
 * of them on the day this ships — and that reads as data loss, not as a filter.
 */
describe('cityFilter()', () => {
  it('matches the structured column and the free-text address', () => {
    const f = cityFilter('Brazzaville');
    expect(f.OR).toEqual([
      { city: { equals: 'Brazzaville', mode: 'insensitive' } },
      { address: { contains: 'Brazzaville', mode: 'insensitive' } },
    ]);
  });

  it('trims, so a stray space cannot make a real city match nothing', () => {
    const f = cityFilter('  Pointe-Noire  ');
    expect(f.OR[0].city.equals).toBe('Pointe-Noire');
    expect(f.OR[1].address.contains).toBe('Pointe-Noire');
  });

  it('compares case-insensitively on both sides', () => {
    const f = cityFilter('brazzaville');
    expect(f.OR[0].city.mode).toBe('insensitive');
    expect(f.OR[1].address.mode).toBe('insensitive');
  });
});

describe('withCityFilter()', () => {
  it('leaves the where untouched when no city is given', () => {
    const where = { status: 'ACTIVE' };
    expect(withCityFilter(where, undefined)).toBe(where);
    expect(withCityFilter(where, null)).toBe(where);
    expect(withCityFilter(where, '   ')).toBe(where);
  });

  it('appends to an existing AND rather than replacing it', () => {
    // Both callers build `where.AND` from free-text search tokens. Dropping
    // those would widen the result set instead of narrowing it — a filter that
    // silently returns MORE rows is the worst way for this to break.
    const where = { AND: [{ title: { contains: 'plombier' } }] };
    const out = withCityFilter(where, 'Brazzaville');

    expect(out.AND).toHaveLength(2);
    expect(out.AND[0]).toEqual({ title: { contains: 'plombier' } });
    expect(out.AND[1]).toEqual(cityFilter('Brazzaville'));
  });

  it('normalises a bare-object AND into an array', () => {
    // Prisma accepts an object there, and spreading one would produce {0: …}
    // rather than appending — leaving the city clause silently inert.
    const where = { AND: { title: { contains: 'plombier' } } };
    const out = withCityFilter(where, 'Dolisie');

    expect(Array.isArray(out.AND)).toBe(true);
    expect(out.AND).toHaveLength(2);
  });

  it('creates AND when the where has none', () => {
    const out = withCityFilter({ status: 'ACTIVE' }, 'Owando');
    expect(out).toEqual({
      status: 'ACTIVE',
      AND: [cityFilter('Owando')],
    });
  });

  it('does not mutate the caller’s where', () => {
    const where = { AND: [{ title: { contains: 'x' } }] };
    withCityFilter(where, 'Brazzaville');
    expect(where.AND).toHaveLength(1);
  });
});
