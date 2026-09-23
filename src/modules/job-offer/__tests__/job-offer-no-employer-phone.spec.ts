import { JobOfferService } from '../job-offer.service';

/**
 * findById and findByReference back the WORKER's job feed, job detail and saved
 * jobs, and the feed spreads the result straight into the response. They used
 * to select the employer's phone, so every worker got the number of the
 * employer behind every offer they scrolled past — no application, no payment.
 */
describe('JobOfferService — employer contact never leaves through an offer', () => {
  function serviceWith(query: jest.Mock) {
    // findById uses findFirst, findByReference findUnique; both get the mock.
    const prisma = { jobOffer: { findFirst: query, findUnique: query } };
    // Only the prisma dependency is exercised by these two methods.
    return new (JobOfferService as unknown as new (...a: unknown[]) => JobOfferService)(
      prisma,
      ...Array(12).fill({}),
    );
  }

  it.each(['findById', 'findByReference'] as const)(
    '%s does not SELECT the employer phone',
    async (method) => {
      const query = jest.fn().mockResolvedValue(null);
      // A real reference shape: findByReference rejects malformed ones before
      // it ever queries.
      await serviceWith(query)[method]('RBT-6CV5H');
      const select = query.mock.calls[0][0].include.employer.select;
      expect(select).not.toHaveProperty('phone');
      expect(select).not.toHaveProperty('email');
    },
  );
});
