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
