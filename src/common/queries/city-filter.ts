/**
 * Matches a city against BOTH the structured `city` column and the free-text
 * `address`.
 *
 * The column is the right answer and the only one a filter can group by — but
 * it is null on every row created before the backfill, and null on any row
 * whose owner has no country yet. Matching the column alone would make those
 * rows vanish from search the day this shipped, which reads as data loss.
 *
 * The address fallback is not purely transitional either: a job offer inherits
 * its city from the employer, so an offer whose address is in Pointe-Noire but
 * whose employer is in Brazzaville is still findable by its address.
 *
 * Returned as an AND-able clause rather than a top-level `OR`, because both
 * callers already build `where.AND` from search tokens and a second top-level
 * `OR` would silently replace the first.
 */
export function cityFilter(city: string): {
  OR: [
    { city: { equals: string; mode: 'insensitive' } },
    { address: { contains: string; mode: 'insensitive' } },
  ];
} {
  const trimmed = city.trim();
  return {
    OR: [
      { city: { equals: trimmed, mode: 'insensitive' } },
      { address: { contains: trimmed, mode: 'insensitive' } },
    ],
  };
}

/**
 * Adds a city clause to a `where` that may already carry an `AND` array.
 *
 * Normalises `AND` to an array first: Prisma accepts a bare object there, and
 * spreading one would produce `{0: …}` rather than appending to it.
 */
export function withCityFilter<T extends object>(
  where: T,
  city: string | undefined | null,
): T {
  if (!city?.trim()) return where;

  // `T extends { AND?: unknown }` would read better but is a WEAK type: TS then
  // rejects any where that happens not to mention AND — which is most of them,
  // and every hand-written test fixture.
  const existing = (where as { AND?: unknown }).AND;
  const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
  return { ...where, AND: [...list, cityFilter(city)] };
}
