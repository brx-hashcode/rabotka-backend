import { ForbiddenException } from '@nestjs/common';
import { JobOfferStatus, ProfileType } from '@prisma/client';
import { MobileFeedController } from '../mobile-feed.controller';

type Req = { user: { profileId: string } };
const reqFor = (profileId: string): Req => ({ user: { profileId } });

/** Minimal row matching JOB_SEARCH_SELECT, so the mapper has something to chew. */
const searchRow = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  reference: 'RBT-AB3K9',
  title: 'Ménage bureau',
  description: 'desc',
  status: JobOfferStatus.ACTIVE,
  scheduled_at: new Date('2026-08-01T10:00:00Z'),
  amount: 20000,
  payment_flow: 'DAILY',
  address: 'Bacongo, Brazzaville',
  quantity: 2,
  created_at: new Date('2026-07-30T10:00:00Z'),
  category: { id: 'c1', name: 'Menage' },
  employer: {
    id: 'e1',
    first_name: 'Marie',
    last_name: 'Lore',
    reliability_score: 100,
    avatar_url: null,
    rating_avg: 4,
    rating_count: 3,
  },
  _count: { applications: 1 },
  ...over,
});

describe('MobileFeedController', () => {
  let controller: MobileFeedController;
  let prisma: {
    profile: { findUnique: jest.Mock };
    jobOffer: { findMany: jest.Mock; count: jest.Mock };
    jobCategory: { findMany: jest.Mock };
    profileCategory: { findMany: jest.Mock };
    savedJob: { findMany: jest.Mock };
    application: { findMany: jest.Mock };
  };
  let jobOfferService: { findById: jest.Mock; findByEmployerId: jest.Mock };
  let applicationService: { findByEmployer: jest.Mock };
  let matchingService: { findMatchingJobsForWorker: jest.Mock };
  let rollout: { versionFor: jest.Mock };
  let engine: { recommendJobsForWorker: jest.Mock };
  let interactionEvents: {
    record: jest.Mock;
    recordMany: jest.Mock;
    recordImpressions: jest.Mock;
  };

  const mockType = (type: ProfileType | null) =>
    prisma.profile.findUnique.mockResolvedValue(
      type ? { profile_type: type } : null,
    );

  /** The `where` handed to jobOffer.findMany on the last call. */
  const lastWhere = () => prisma.jobOffer.findMany.mock.calls.at(-1)?.[0].where;
  /** "Pour vous" now issues several offer queries; assert against any of them. */
  const allWheres = () =>
    prisma.jobOffer.findMany.mock.calls.map(
      (c: unknown[]) => (c[0] as any).where,
    );
  const lastArgs = () => prisma.jobOffer.findMany.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    prisma = {
      profile: { findUnique: jest.fn() },
      jobOffer: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      jobCategory: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      profileCategory: { findMany: jest.fn().mockResolvedValue([]) },
      savedJob: { findMany: jest.fn().mockResolvedValue([]) },
      application: { findMany: jest.fn().mockResolvedValue([]) },
    };
    jobOfferService = { findById: jest.fn(), findByEmployerId: jest.fn() };
    applicationService = { findByEmployer: jest.fn() };
    // Similarity off by default — the common production case.
    matchingService = {
      findMatchingJobsForWorker: jest.fn().mockResolvedValue([]),
    };
    // Legacy by default — the v2 ranker is behind a rollout flag.
    rollout = { versionFor: jest.fn().mockResolvedValue('legacy') };
    engine = { recommendJobsForWorker: jest.fn().mockResolvedValue([]) };

    interactionEvents = {
      record: jest.fn(),
      recordMany: jest.fn(),
      recordImpressions: jest.fn(),
    };
    controller = new MobileFeedController(
      prisma as never,
      jobOfferService as never,
      applicationService as never,
      matchingService as never,
      rollout as never,
      engine as never,
      interactionEvents as never,
    );
  });

  describe('job-feed (WORKER)', () => {
    it('hydrates offer ids into offers with saved/applied flags', async () => {
      mockType(ProfileType.WORKER);
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'job-1' },
        { id: 'job-2' },
      ]);
      jobOfferService.findById
        .mockResolvedValueOnce({ id: 'job-1', title: 'A' })
        .mockResolvedValueOnce({ id: 'job-2', title: 'B' });
      prisma.savedJob.findMany.mockResolvedValue([{ job_offer_id: 'job-2' }]);

      const result = await controller.jobFeed(reqFor('w1') as never, '10');

      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10 }),
      );
      expect(result).toEqual([
        {
          id: 'job-1',
          title: 'A',
          matchScore: 0,
          saved: false,
          applied: false,
          // Null, not absent: the card decides whether to offer the chat
          // button on this field, so "no live application" has to be a value
          // it can read rather than a key it has to test for.
          applicationId: null,
          applicationState: 'NONE',
        },
        {
          id: 'job-2',
          title: 'B',
          matchScore: 0,
          saved: true,
          applied: false,
          applicationId: null,
          applicationState: 'NONE',
        },
      ]);
    });

    it('pins to a single category when categoryId is given', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobFeed(reqFor('w1') as never, undefined, 'cat-9');
      expect(lastWhere()).toMatchObject({ category_id: { in: ['cat-9'] } });
      // A chip is an explicit choice — don't let the recommender override it.
      expect(matchingService.findMatchingJobsForWorker).not.toHaveBeenCalled();
    });

    it('"Pour vous" uses semantic matches when the recommender returns some', async () => {
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([
        { id: 'job-9', score: 0.91 },
      ]);
      // keepOpenOffers confirms it is still open.
      prisma.jobOffer.findMany.mockResolvedValue([{ id: 'job-9' }]);
      jobOfferService.findById.mockResolvedValue({ id: 'job-9', title: 'Z' });

      const result = await controller.jobFeed(reqFor('w1') as never);

      expect(result).toEqual([
        {
          id: 'job-9',
          title: 'Z',
          applicationId: null,
          applicationState: 'NONE',
          matchScore: 0.91,
          saved: false,
          applied: false,
        },
      ]);
    });

    it('drops matched offers that are no longer open (stale vector index)', async () => {
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([
        { id: 'open', score: 0.9 },
        { id: 'filled', score: 0.8 },
      ]);
      // Only `open` comes back from the open-offer check...
      prisma.jobOffer.findMany.mockResolvedValueOnce([{ id: 'open' }]);
      jobOfferService.findById.mockResolvedValue({ id: 'open', title: 'A' });

      const result = await controller.jobFeed(reqFor('w1') as never);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('open');
    });

    it("tops up with the worker's own domains", async () => {
      mockType(ProfileType.WORKER);
      prisma.profileCategory.findMany.mockResolvedValue([
        { category_id: 'c1' },
        { category_id: 'c2' },
      ]);

      await controller.jobFeed(reqFor('w1') as never);

      expect(allWheres()).toContainEqual(
        expect.objectContaining({ category_id: { in: ['c1', 'c2'] } }),
      );
    });

    it('also asks for every open offer, so nothing visible under a chip is missing', async () => {
      mockType(ProfileType.WORKER);
      prisma.profileCategory.findMany.mockResolvedValue([
        { category_id: 'c1' },
      ]);

      await controller.jobFeed(reqFor('w1') as never);

      // The last query is the unrestricted one.
      expect(lastWhere().category_id).toBeUndefined();
      expect(lastWhere()).toMatchObject({ deleted_at: null });
    });

    it('keeps ranked hits on top and fills the rest of the page', async () => {
      // The bug this replaces: one semantic hit produced a one-item feed while a
      // domain chip listed several, because the ranked set replaced the feed
      // instead of ordering it.
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([
        { id: 'ranked', score: 0.91 },
      ]);
      prisma.jobOffer.findMany
        .mockResolvedValueOnce([{ id: 'ranked' }]) // keepOpenOffers
        .mockResolvedValueOnce([{ id: 'own-domain' }]) // worker's categories
        .mockResolvedValueOnce([{ id: 'ranked' }, { id: 'anything' }]); // everything
      jobOfferService.findById.mockImplementation((id: string) =>
        Promise.resolve({ id, title: id }),
      );

      const result = await controller.jobFeed(reqFor('w1') as never);

      expect(result.map((r: { id: string }) => r.id)).toEqual([
        'ranked',
        'own-domain',
        'anything',
      ]);
      expect(result[0].matchScore).toBe(0.91);
    });

    it('never exceeds the requested page size', async () => {
      mockType(ProfileType.WORKER);
      matchingService.findMatchingJobsForWorker.mockResolvedValue([]);
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]);
      jobOfferService.findById.mockImplementation((id: string) =>
        Promise.resolve({ id, title: id }),
      );

      const result = await controller.jobFeed(reqFor('w1') as never, '2');

      expect(result.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    });

    it('drops ids that no longer resolve to an offer', async () => {
      mockType(ProfileType.WORKER);
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'job-1' },
        { id: 'gone' },
      ]);
      jobOfferService.findById
        .mockResolvedValueOnce({ id: 'job-1', title: 'A' })
        .mockResolvedValueOnce(null);

      const result = await controller.jobFeed(reqFor('w1') as never, undefined);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('job-1');
    });

    it('403s for an EMPLOYER', async () => {
      mockType(ProfileType.EMPLOYER);
      await expect(controller.jobFeed(reqFor('e1') as never)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });
  });

  describe('job-search (WORKER)', () => {
    it('403s for an EMPLOYER', async () => {
      mockType(ProfileType.EMPLOYER);
      await expect(
        controller.jobSearch(reqFor('e1') as never, {}),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('only returns open, non-deleted offers by default', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, {});
      expect(lastWhere()).toEqual({
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        deleted_at: null,
      });
    });

    it('narrows to the jobs the text search matched, keeping the city filter', async () => {
      mockType(ProfileType.WORKER);
      prisma.$queryRaw.mockResolvedValue([{ id: 'j1' }, { id: 'j2' }]);
      await controller.jobSearch(reqFor('w1') as never, {
        q: 'Ménage bacongo',
        city: 'Brazzaville',
      });

      expect(lastWhere().id).toEqual({ in: ['j1', 'j2'] });
      // The search no longer overwrites `AND`, where the city filter lives.
      expect(lastWhere().AND).toHaveLength(1);
      const values = JSON.stringify(prisma.$queryRaw.mock.calls[0].slice(1));
      expect(values).toContain('%menage%');
      expect(values).toContain('%bacongo%');
    });

    it('matches nothing when the search matched nothing', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: 'zzzz' });
      expect(lastWhere().id).toEqual({ in: [] });
    });

    it('skips the search query for a blank or stopword-only text', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: '  de la ' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(lastWhere().id).toBeUndefined();
    });

    it('searches title and category fuzzily, description/address/reference as written', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: 'developer' });
      const values = JSON.stringify(prisma.$queryRaw.mock.calls[0].slice(1));
      expect(values).toContain('strict_word_similarity');
      for (const field of [
        'o.title',
        'c.name',
        'o.description',
        'o.address',
        'o.reference',
      ]) {
        expect(values).toContain(field);
      }
    });

    it('falls back to pageSize 15 when it is 0 or garbage', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { pageSize: '0' });
      expect(lastArgs().take).toBe(15);

      await controller.jobSearch(reqFor('w1') as never, { pageSize: 'abc' });
      expect(lastArgs().take).toBe(15);
    });

    it('caps pageSize at 50 and offsets by page', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, {
        pageSize: '999',
        page: '2',
      });
      expect(lastArgs().take).toBe(50);
      expect(lastArgs().skip).toBe(100);
    });

    it('maps each sort to an orderBy ending on id', async () => {
      mockType(ProfileType.WORKER);

      await controller.jobSearch(reqFor('w1') as never, {});
      expect(lastArgs().orderBy).toEqual([
        { created_at: 'desc' },
        { id: 'asc' },
      ]);

      await controller.jobSearch(reqFor('w1') as never, { sort: 'soon' });
      expect(lastArgs().orderBy[0]).toEqual({ scheduled_at: 'asc' });

      await controller.jobSearch(reqFor('w1') as never, {
        sort: 'amount_desc',
      });
      expect(lastArgs().orderBy[0]).toEqual({
        amount: { sort: 'desc', nulls: 'last' },
      });

      await controller.jobSearch(reqFor('w1') as never, { sort: 'nonsense' });
      expect(lastArgs().orderBy[0]).toEqual({ created_at: 'desc' });
    });

    it('applies the filter params', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, {
        categoryId: 'c1',
        city: ' Bacongo ',
        paymentFlow: 'DAILY',
        minAmount: '5000',
        hideApplied: '1',
      });

      expect(lastWhere()).toMatchObject({
        category_id: 'c1',
        payment_flow: 'DAILY',
        amount: { gte: 5000 },
        applications: { none: { worker_id: 'w1' } },
      });

      // City now matches the structured column as well as the free-text
      // address. Matching only the column would hide every offer created
      // before the backfill; matching only the address is what this replaced.
      expect(lastWhere().AND).toContainEqual({
        OR: [
          { city: { equals: 'Bacongo', mode: 'insensitive' } },
          { address: { contains: 'Bacongo', mode: 'insensitive' } },
        ],
      });
    });

    it('ignores an unknown paymentFlow and unparseable bounds', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, {
        paymentFlow: 'WEEKLY',
        minAmount: 'abc',
        from: 'not-a-date',
      });

      const where = lastWhere();
      expect(where.payment_flow).toBeUndefined();
      expect(where.amount).toBeUndefined();
      expect(where.scheduled_at).toBeUndefined();
    });

    it('returns { items, total } with flags and a numeric amount', async () => {
      mockType(ProfileType.WORKER);
      prisma.jobOffer.findMany.mockResolvedValue([searchRow()]);
      prisma.jobOffer.count.mockResolvedValue(1);
      // The full shape the feed now selects: the applied flag comes from
      // reapplyDecision, which reads status, cancelled_by and deleted_at.
      prisma.application.findMany.mockResolvedValue([
        {
          id: 'app-1',
          job_offer_id: 'job-1',
          status: 'PENDING',
          cancelled_by: null,
          deleted_at: null,
        },
      ]);

      const result = await controller.jobSearch(reqFor('w1') as never, {});

      expect(result.total).toBe(1);
      expect(result.items[0]).toMatchObject({
        id: 'job-1',
        reference: 'RBT-AB3K9',
        amount: 20000,
        acceptedCount: 1,
        categoryId: 'c1',
        categoryName: 'Menage',
        saved: false,
        applied: true,
      });
      expect(result.items[0].employer).not.toHaveProperty('phone');
    });

    it('keeps a null amount null rather than coercing to 0', async () => {
      mockType(ProfileType.WORKER);
      prisma.jobOffer.findMany.mockResolvedValue([searchRow({ amount: null })]);
      const result = await controller.jobSearch(reqFor('w1') as never, {});
      expect(result.items[0].amount).toBeNull();
    });

    it('counts with the same where as the page query', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: 'menage' });
      expect(prisma.jobOffer.count).toHaveBeenCalledWith({
        where: lastWhere(),
      });
    });
  });

  describe('job-offers (EMPLOYER)', () => {
    it('returns the employer’s offers', async () => {
      mockType(ProfileType.EMPLOYER);
      jobOfferService.findByEmployerId.mockResolvedValue({
        items: [{ id: 'o1' }],
        total: 1,
      });

      const result = await controller.myJobOffers(reqFor('e1') as never);

      expect(jobOfferService.findByEmployerId).toHaveBeenCalledWith('e1', {
        page: 0,
        pageSize: 20,
      });
      expect(result).toEqual({ items: [{ id: 'o1' }], total: 1 });
    });

    it('403s for a WORKER', async () => {
      mockType(ProfileType.WORKER);
      await expect(
        controller.myJobOffers(reqFor('w1') as never),
      ).rejects.toThrow(ForbiddenException);
      expect(jobOfferService.findByEmployerId).not.toHaveBeenCalled();
    });
  });

  describe('received-applications (EMPLOYER)', () => {
    it('returns applications received', async () => {
      mockType(ProfileType.EMPLOYER);
      applicationService.findByEmployer.mockResolvedValue({
        items: [{ id: 'a1' }],
        total: 1,
      });

      const result = await controller.receivedApplications(
        reqFor('e1') as never,
      );

      expect(applicationService.findByEmployer).toHaveBeenCalledWith('e1', {
        page: 0,
        pageSize: 20,
      });
      expect(result).toEqual({ items: [{ id: 'a1' }], total: 1 });
    });

    it('403s for a WORKER', async () => {
      mockType(ProfileType.WORKER);
      await expect(
        controller.receivedApplications(reqFor('w1') as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
