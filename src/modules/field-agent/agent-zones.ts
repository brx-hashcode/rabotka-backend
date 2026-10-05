import { JobOfferStatus, Prisma } from '@prisma/client';

/** Offers an agent can still do something about. */
const OPEN_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

export type Zone = { country_code: string; city: string };

/**
 * The jobs an agent may see: open, not deleted, and located in one of their
 * zones.
 *
 * "Located" uses the same fallback the ranker does (candidate-sources.ts): the
 * offer's own city, or the employer's when the offer names none — a job is
 * usually where the person posting it is. Case-insensitive because a city
 * written before GeoService snapped spellings may differ in case only.
 *
 * Its own file because both the portal and the lead service need it, and the
 * portal service injects the lead service — sharing it through either would
 * be a circular import, which Nest only finds at boot.
 */
export function jobsInZonesWhere(zones: Zone[]): Prisma.JobOfferWhereInput {
  return {
    deleted_at: null,
    status: { in: OPEN_STATUSES },
    OR: zones.flatMap((z) => [
      {
        country_code: z.country_code,
        city: { equals: z.city, mode: 'insensitive' as const },
      },
      {
        city: null,
        employer: {
          country_code: z.country_code,
          city: { equals: z.city, mode: 'insensitive' as const },
        },
      },
    ]),
  };
}

export type PublicJobsFilter = { country?: string; city?: string; q?: string };

/**
 * The jobs anyone may browse on the agent app's front page: every open job,
 * optionally narrowed to a country and/or city and a title search.
 *
 * Location follows the same fallback as `jobsInZonesWhere` — the offer's own
 * place, or the employer's when the offer names none.
 */
export function publicJobsWhere(
  filter: PublicJobsFilter,
): Prisma.JobOfferWhereInput {
  const and: Prisma.JobOfferWhereInput[] = [];
  const country = filter.country?.toUpperCase();

  if (filter.city) {
    const city = { equals: filter.city, mode: 'insensitive' as const };
    const inCountry = country ? { country_code: country } : {};
    and.push({
      OR: [
        { ...inCountry, city },
        { city: null, employer: { ...inCountry, city } },
      ],
    });
  } else if (country) {
    and.push({
      OR: [
        { country_code: country },
        { country_code: null, employer: { country_code: country } },
      ],
    });
  }

  if (filter.q) {
    and.push({
      OR: [
        { title: { contains: filter.q, mode: 'insensitive' } },
        { reference: { contains: filter.q, mode: 'insensitive' } },
      ],
    });
  }

  return {
    deleted_at: null,
    status: { in: OPEN_STATUSES },
    ...(and.length > 0 ? { AND: and } : {}),
  };
}
