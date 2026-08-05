import { ForbiddenException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { ContactedProfilesService } from '../../recommendation/contacted-profiles.service';
import { MobileRecommendationController } from '../mobile-recommendation.controller';

type Req = { user: { profileId: string } };
const reqFor = (profileId: string): Req => ({ user: { profileId } });

/** Minimal row matching WORKER_SELECT. */
const workerRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  first_name: 'Awa',
  last_name: 'Menagere',
  avatar_url: null,
  reliability_score: 100,
  rating_avg: 4,
  rating_count: 2,
  description: 'Nettoyage',
  portfolio_slug: null,
  categories: [{ category: { name: 'Menage' } }],
  ...over,
});

describe('MobileRecommendationController — worker-feed tiers', () => {
  let controller: MobileRecommendationController;
  let prisma: {
    profile: { findUnique: jest.Mock; findMany: jest.Mock };
    jobOffer: { findMany: jest.Mock };
    application: { groupBy: jest.Mock };
    walletTransaction: { findMany: jest.Mock };
    paymentRequest: { findMany: jest.Mock };
  };
  let matching: { findMatchingWorkersForEmployerProfile: jest.Mock };
  let systemConfig: { getFees: jest.Mock };
  let interactionEvents: { record: jest.Mock };
  let rollout: { versionFor: jest.Mock };
  let engine: { recommendWorkersForEmployer: jest.Mock };

  const mockType = (type: ProfileType | null) =>
    prisma.profile.findUnique.mockResolvedValue(
      type ? { profile_type: type } : null,
    );

  // profile.findMany serves two distinct queries: the eligibility scan (keyed by
  // `profile_type`) and hydrate's lookup by id. Tests must not conflate them.
  const isEligibilityQuery = (where: { profile_type?: unknown }) =>
    where.profile_type !== undefined;

  const eligibilityWheres = () =>
    prisma.profile.findMany.mock.calls
      .map((c) => c[0].where)
      .filter(isEligibilityQuery);

  /** `where` of the last eligible-worker scan. */
  const lastProfileWhere = () => eligibilityWheres().at(-1);

  /**
   * Route the two queries independently: `eligible` receives the scan's `where`
   * and returns id rows; `hydrated` is what hydrate resolves them to.
   */
  const mockProfileQueries = (opts: {
    eligible?: (where: {
      categories?: unknown;
      id?: unknown;
    }) => { id: string }[];
    hydrated?: ReturnType<typeof workerRow>[];
  }) => {
    prisma.profile.findMany.mockImplementation((args: { where: never }) =>
      Promise.resolve(
        isEligibilityQuery(args.where)
          ? (opts.eligible?.(args.where) ?? [])
          : (opts.hydrated ?? []),
      ),
    );
  };

  beforeEach(() => {
    prisma = {
      profile: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      jobOffer: { findMany: jest.fn().mockResolvedValue([]) },
      application: { groupBy: jest.fn().mockResolvedValue([]) },
      walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      paymentRequest: { findMany: jest.fn().mockResolvedValue([]) },
    };
    // Similarity off by default — the common production case.
    matching = {
      findMatchingWorkersForEmployerProfile: jest.fn().mockResolvedValue([]),
    };
    systemConfig = {
      getFees: jest.fn().mockResolvedValue({ reliabilityScoreMin: 50 }),
    };

    interactionEvents = { record: jest.fn().mockResolvedValue(undefined) };
    // Legacy by default — the v2 ranker is behind a rollout flag.
    rollout = { versionFor: jest.fn().mockResolvedValue('legacy') };
    engine = { recommendWorkersForEmployer: jest.fn().mockResolvedValue([]) };

    controller = new MobileRecommendationController(
      prisma as never,
      matching as never,
      systemConfig as never,
      {} as never,
      {} as never,
      interactionEvents as never,
      rollout as never,
      engine as never,
      // The real service on the same prisma mock: the exclusion assertions below
      // are only meaningful if the derivation itself runs.
      new ContactedProfilesService(prisma as never),
      // Returns a slug so workerDetail() does not try to mint one; the
      // mint-on-demand path has its own test below.
      { ensurePortfolioSlug: jest.fn().mockResolvedValue('awa-a1b2c3') } as never,
    );
  });

  it('403s for a WORKER', async () => {
    mockType(ProfileType.WORKER);
    await expect(
      controller.workerFeed(reqFor('w1') as never),
    ).rejects.toThrow(ForbiddenException);
    expect(
      matching.findMatchingWorkersForEmployerProfile,
    ).not.toHaveBeenCalled();
  });

  describe('tier 1 — semantic recommendations', () => {
    it('returns matched workers and carries the AI score', async () => {
      mockType(ProfileType.EMPLOYER);
      matching.findMatchingWorkersForEmployerProfile.mockResolvedValue([
        { id: 'w-9', score: 0.69 },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w-9')]);

      const result = await controller.workerFeed(reqFor('e1') as never);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('w-9');
      expect(result[0].score).toBe(0.69);
      // Never reached the domain fallback.
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('excludes already-contacted workers', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.walletTransaction.findMany.mockResolvedValue([
        { reference_id: 'w-contacted' },
      ]);
      matching.findMatchingWorkersForEmployerProfile.mockResolvedValue([
        { id: 'w-contacted', score: 0.9 },
        { id: 'w-fresh', score: 0.8 },
      ]);
      prisma.profile.findMany.mockResolvedValue([workerRow('w-fresh')]);

      const result = await controller.workerFeed(reqFor('e1') as never);

      expect(result.map((w) => w.id)).toEqual(['w-fresh']);
    });
  });

  describe('tier 2 — the employer’s own domains', () => {
    it('falls through to offer categories when nothing is matched', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.jobOffer.findMany.mockResolvedValue([
        { category_id: 'c1' },
        { category_id: 'c2' },
      ]);
      mockProfileQueries({
        eligible: () => [{ id: 'w-1' }],
        hydrated: [workerRow('w-1')],
      });

      const result = await controller.workerFeed(reqFor('e1') as never);

      expect(lastProfileWhere()).toMatchObject({
        profile_type: ProfileType.WORKER,
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        deleted_at: null,
        reliability_score: { gte: 50 },
        categories: { some: { category_id: { in: ['c1', 'c2'] } } },
      });
      expect(result.map((w) => w.id)).toEqual(['w-1']);
      // No AI score in this tier — the card hides the badge at 0.
      expect(result[0].score).toBe(0);
    });

    it('ignores offers with no category', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.jobOffer.findMany.mockResolvedValue([
        { category_id: 'c1' },
        { category_id: null },
      ]);
      await controller.workerFeed(reqFor('e1') as never);
      // The domain scan is the first eligibility query (it finds nobody here, so
      // a second, unfiltered one follows).
      expect(eligibilityWheres()[0].categories).toEqual({
        some: { category_id: { in: ['c1'] } },
      });
    });

    it('excludes already-contacted workers here too', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.paymentRequest.findMany.mockResolvedValue([
        { recommendation_worker_id: 'w-contacted' },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([{ category_id: 'c1' }]);

      await controller.workerFeed(reqFor('e1') as never);

      expect(lastProfileWhere().id).toEqual({ notIn: ['w-contacted'] });
    });
  });

  describe('tier 3 — any eligible worker', () => {
    it('drops the category filter when the employer has no offers', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.jobOffer.findMany.mockResolvedValue([]);

      await controller.workerFeed(reqFor('e1') as never);

      expect(lastProfileWhere().categories).toBeUndefined();
      expect(lastProfileWhere()).toMatchObject({ status: 'ACTIVE' });
    });

    it('drops the category filter when the domain tier finds nobody', async () => {
      mockType(ProfileType.EMPLOYER);
      prisma.jobOffer.findMany.mockResolvedValue([{ category_id: 'c1' }]);
      // Nobody in the employer's domains; somebody once the filter is dropped.
      mockProfileQueries({
        eligible: (where) => (where.categories ? [] : [{ id: 'w-any' }]),
        hydrated: [workerRow('w-any')],
      });

      const result = await controller.workerFeed(reqFor('e1') as never);

      expect(eligibilityWheres()).toHaveLength(2);
      expect(lastProfileWhere().categories).toBeUndefined();
      expect(result.map((w) => w.id)).toEqual(['w-any']);
    });

    it('survives the matcher resolving undefined', async () => {
      mockType(ProfileType.EMPLOYER);
      matching.findMatchingWorkersForEmployerProfile.mockResolvedValue(
        undefined,
      );
      mockProfileQueries({
        eligible: () => [{ id: 'w-any' }],
        hydrated: [workerRow('w-any')],
      });

      const result = await controller.workerFeed(reqFor('e1') as never);
      expect(result.map((w) => w.id)).toEqual(['w-any']);
    });
  });
});
