import { ProfileType, VerificationStatus } from '@prisma/client';
import { MobileRecommendationController } from '../mobile-recommendation.controller';

const WORKER_ID = 'w-1';
const EMPLOYER_ID = 'e-1';

const workerRow = (over: Record<string, unknown> = {}) => ({
  id: WORKER_ID,
  first_name: 'Awa',
  last_name: 'Menagere',
  avatar_url: null,
  reliability_score: 100,
  rating_avg: 4,
  rating_count: 2,
  description: 'Nettoyage',
  portfolio_slug: null,
  address: 'Bacongo, Brazzaville',
  verification_status: VerificationStatus.VERIFIED,
  categories: [
    { category: { name: 'Ménage' } },
    { category: { name: 'Repassage' } },
  ],
  ...over,
});

/**
 * The detail an employer reads before paying to make contact.
 *
 * Two behaviours are pinned here because both were silently wrong: a worker who
 * had never uploaded a realization had no portfolio slug and therefore no way
 * to be viewed, and `WORKER_SELECT` truncated categories to one so a
 * multi-skilled worker looked like a specialist.
 */
describe('MobileRecommendationController — workerDetail()', () => {
  let controller: MobileRecommendationController;
  let prisma: {
    profile: { findUnique: jest.Mock; findMany: jest.Mock };
    application: { groupBy: jest.Mock };
  };
  let portfolio: { ensurePortfolioSlug: jest.Mock };

  const build = (row = workerRow()) => {
    prisma = {
      profile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ profile_type: ProfileType.EMPLOYER }),
        findMany: jest.fn().mockResolvedValue([row]),
      },
      application: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    portfolio = {
      ensurePortfolioSlug: jest.fn().mockResolvedValue('awa-menagere-a1b2c3'),
    };

    controller = new MobileRecommendationController(
      prisma as never,
      { findMatchingWorkersForEmployerProfile: jest.fn() } as never,
      {
        getFees: jest.fn().mockResolvedValue({ reliabilityScoreMin: 50 }),
        getRecommendationContactFee: jest.fn().mockResolvedValue(1000),
      } as never,
      { getProfileWalletBalance: jest.fn().mockResolvedValue(2000) } as never,
      {} as never,
      { record: jest.fn() } as never,
      { versionFor: jest.fn().mockResolvedValue('legacy') } as never,
      { recommendWorkersForEmployer: jest.fn() } as never,
      { excludeContacted: jest.fn() } as never,
      portfolio as never,
    );
  };

  const req = { user: { profileId: EMPLOYER_ID } };

  it('mints a portfolio slug for a worker who has none', async () => {
    // The whole reason existing workers were unreachable: the slug used to be
    // created only on the first realization upload.
    build(workerRow({ portfolio_slug: null }));

    const result = await controller.workerDetail(req as never, WORKER_ID);

    expect(portfolio.ensurePortfolioSlug).toHaveBeenCalledWith(WORKER_ID);
    expect(result.worker.portfolioSlug).toBe('awa-menagere-a1b2c3');
  });

  it('leaves an existing slug alone', async () => {
    build(workerRow({ portfolio_slug: 'already-there' }));

    const result = await controller.workerDetail(req as never, WORKER_ID);

    expect(portfolio.ensurePortfolioSlug).not.toHaveBeenCalled();
    expect(result.worker.portfolioSlug).toBe('already-there');
  });

  it('still returns the worker when minting fails', async () => {
    build(workerRow({ portfolio_slug: null }));
    portfolio.ensurePortfolioSlug.mockRejectedValue(new Error('redis down'));

    const result = await controller.workerDetail(req as never, WORKER_ID);

    // A hidden portfolio button is a far smaller problem than a detail page
    // that will not load.
    expect(result.worker.portfolioSlug).toBeNull();
    expect(result.worker.id).toBe(WORKER_ID);
  });

  it('returns every domain, not just the first', async () => {
    build();

    const result = await controller.workerDetail(req as never, WORKER_ID);

    expect(result.worker.categoryNames).toEqual(['Ménage', 'Repassage']);
    // Kept for the compact card, which shows one.
    expect(result.worker.categoryName).toBe('Ménage');
  });

  it('reports verification as a positive flag only', async () => {
    build(workerRow({ verification_status: VerificationStatus.VERIFIED }));
    const verified = await controller.workerDetail(req as never, WORKER_ID);
    expect(verified.worker.isVerified).toBe(true);

    // PENDING and REJECTED are moderation outcomes; both simply read false so
    // no badge is shown, rather than publishing the outcome to employers.
    build(workerRow({ verification_status: VerificationStatus.REJECTED }));
    const rejected = await controller.workerDetail(req as never, WORKER_ID);
    expect(rejected.worker.isVerified).toBe(false);
  });

  it('carries the fee and balance the confirm sheet needs', async () => {
    build();
    const result = await controller.workerDetail(req as never, WORKER_ID);
    expect(result.recommendationFee).toBe(1000);
    expect(result.walletBalance).toBe(2000);
  });
});
