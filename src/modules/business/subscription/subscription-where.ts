import { Prisma } from '@prisma/client';

/**
 * Offers field agents may work on: any regular employer's, and a business's
 * only while it has a running plan (trial or paid).
 * A where-clause rather than a service call so the agent lists filter in SQL.
 */
export function fieldAgentsEligibleWhere(
  now = new Date(),
): Prisma.JobOfferWhereInput {
  return {
    OR: [
      { employer: { is_business: false } },
      {
        employer: {
          business: {
            subscriptions: {
              some: {
                status: { in: ['TRIAL', 'ACTIVE'] },
                starts_at: { lte: now },
                ends_at: { gt: now },
              },
            },
          },
        },
      },
    ],
  };
}

/** Priority offers first (a business plan with priority visibility). */
export const PRIORITY_FIRST: Prisma.JobOfferOrderByWithRelationInput = {
  priority_until: { sort: 'desc', nulls: 'last' },
};
