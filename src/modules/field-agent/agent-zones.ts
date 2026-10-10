import { EmploymentType, JobOfferStatus, Prisma } from '@prisma/client';

/** Offers an agent can still do something about. */
export const OPEN_STATUSES: JobOfferStatus[] = [
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

/** Narrowing a job list, shared by the public feed and an agent's own feed. */
export type JobFilters = {
  q?: string;
  /**
   * Jobs matching `q`, resolved beforehand by `matchingJobIds` (accents,
   * partial words and misspellings). When set it replaces `q`'s plain
   * substring match.
   */
  matchingIds?: string[];
  employmentTypes?: EmploymentType[];
  /** Category slugs. */
  categories?: string[];
  /** Agent feed only: the public feed never filters or reveals pay. */
  minAmount?: number;
  maxAmount?: number;
};

export type PublicJobsFilter = {
  country?: string;
  city?: string;
} & Omit<JobFilters, 'minAmount' | 'maxAmount'>;

export type JobSort = 'recent' | 'start';

export function jobsOrderBy(
  sort: JobSort = 'recent',
): Prisma.JobOfferOrderByWithRelationInput[] {
  return sort === 'start'
    ? [{ scheduled_at: { sort: 'asc', nulls: 'last' } }, { created_at: 'desc' }]
    : [{ created_at: 'desc' }];
}

/**
 * One AND clause per active filter. Kept separate from the scope (open jobs,
 * zones or location) so facet counts can drop exactly one filter at a time.
 */
export function jobFiltersWhere(f: JobFilters): Prisma.JobOfferWhereInput[] {
  const and: Prisma.JobOfferWhereInput[] = [];

  if (f.matchingIds) {
    and.push({ id: { in: f.matchingIds } });
  } else if (f.q) {
    and.push({
      OR: [
        { title: { contains: f.q, mode: 'insensitive' } },
        { reference: { contains: f.q, mode: 'insensitive' } },
      ],
    });
  }
  if (f.employmentTypes?.length) {
    and.push({ employment_type: { in: f.employmentTypes } });
  }
  if (f.categories?.length) {
    and.push({ category: { slug: { in: f.categories } } });
  }
  if (f.minAmount !== undefined || f.maxAmount !== undefined) {
    and.push({
      amount: {
        ...(f.minAmount !== undefined ? { gte: f.minAmount } : {}),
        ...(f.maxAmount !== undefined ? { lte: f.maxAmount } : {}),
      },
    });
  }
  return and;
}

/**
 * The jobs anyone may browse on the agent app's front page, before filters:
 * every open job, optionally narrowed to a country and/or city.
 *
 * Location follows the same fallback as `jobsInZonesWhere` — the offer's own
 * place, or the employer's when the offer names none.
 */
export function publicScopeWhere(
  filter: Pick<PublicJobsFilter, 'country' | 'city'>,
): Prisma.JobOfferWhereInput {
  const country = filter.country?.toUpperCase();
  let location: Prisma.JobOfferWhereInput | null = null;

  if (filter.city) {
    const city = { equals: filter.city, mode: 'insensitive' as const };
    const inCountry = country ? { country_code: country } : {};
    location = {
      OR: [
        { ...inCountry, city },
        { city: null, employer: { ...inCountry, city } },
      ],
    };
  } else if (country) {
    location = {
      OR: [
        { country_code: country },
        { country_code: null, employer: { country_code: country } },
      ],
    };
  }

  return {
    deleted_at: null,
    status: { in: OPEN_STATUSES },
    ...(location ? { AND: [location] } : {}),
  };
}

/** Scope plus filters, as one where clause. */
export function withFilters(
  scope: Prisma.JobOfferWhereInput,
  filters: JobFilters,
): Prisma.JobOfferWhereInput {
  const and = jobFiltersWhere(filters);
  return and.length > 0 ? { AND: [scope, ...and] } : scope;
}
