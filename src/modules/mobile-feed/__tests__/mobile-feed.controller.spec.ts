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

  const mockType = (type: ProfileType | null) =>
    prisma.profile.findUnique.mockResolvedValue(
      type ? { profile_type: type } : null,
    );

  /** The `where` handed to jobOffer.findMany on the last call. */
  const lastWhere = () => prisma.jobOffer.findMany.mock.calls.at(-1)?.[0].where;
  const lastArgs = () => prisma.jobOffer.findMany.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    prisma = {
      profile: { findUnique: jest.fn() },
      jobOffer: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      jobCategory: { findMany: jest.fn().mockResolvedValue([]) },
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

    controller = new MobileFeedController(
      prisma as never,
      jobOfferService as never,
      applicationService as never,
      matchingService as never,
      rollout as never,
      engine as never,
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
        { id: 'job-1', title: 'A', matchScore: 0, saved: false, applied: false },
        { id: 'job-2', title: 'B', matchScore: 0, saved: true, applied: false },
      ]);
    });

    it('pins to a single category when categoryId is given', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobFeed(reqFor('w1') as never, undefined, 'cat-9');
      expect(lastWhere()).toMatchObject({ category_id: { in: ['cat-9'] } });
      // A chip is an explicit choice — don't let the recommender override it.
      expect(
        matchingService.findMatchingJobsForWorker,
      ).not.toHaveBeenCalled();
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
        { id: 'job-9', title: 'Z', matchScore: 0.91, saved: false, applied: false },
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

    it('falls back to the worker\'s own domains when nothing is matched', async () => {
      mockType(ProfileType.WORKER);
      prisma.profileCategory.findMany.mockResolvedValue([
        { category_id: 'c1' },
        { category_id: 'c2' },
      ]);

      await controller.jobFeed(reqFor('w1') as never);

      expect(lastWhere()).toMatchObject({ category_id: { in: ['c1', 'c2'] } });
    });

    it('falls back to all open offers when the worker has no domains', async () => {
      mockType(ProfileType.WORKER);
      prisma.profileCategory.findMany.mockResolvedValue([]);

      await controller.jobFeed(reqFor('w1') as never);

      expect(lastWhere().category_id).toBeUndefined();
      expect(lastWhere()).toMatchObject({ deleted_at: null });
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

    it('ANDs each token and ORs it across title/description/address/reference', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: 'menage bacongo' });

      const and = lastWhere().AND;
      expect(and).toHaveLength(2);
      expect(and[0].OR).toEqual([
        { title: { contains: 'menage', mode: 'insensitive' } },
        { description: { contains: 'menage', mode: 'insensitive' } },
        { address: { contains: 'menage', mode: 'insensitive' } },
        { reference: { contains: 'menage', mode: 'insensitive' } },
      ]);
    });

    it('caps the token chain at 6', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, {
        q: 'a b c d e f g h',
      });
      expect(lastWhere().AND).toHaveLength(6);
    });

    it('adds a category_id branch for a domaine match, ignoring accents', async () => {
      mockType(ProfileType.WORKER);
      prisma.jobCategory.findMany.mockResolvedValue([
        { id: 'c1', name: 'Ménage' },
        { id: 'c2', name: 'Plomberie' },
      ]);

      await controller.jobSearch(reqFor('w1') as never, { q: 'menage' });

      expect(lastWhere().AND[0].OR).toContainEqual({
        category_id: { in: ['c1'] },
      });
    });

    it('matches a lowercase legacy reference through the reference branch', async () => {
      mockType(ProfileType.WORKER);
      await controller.jobSearch(reqFor('w1') as never, { q: 'rab-7k3x9' });
      expect(lastWhere().AND[0].OR).toContainEqual({
        reference: { contains: 'rab-7k3x9', mode: 'insensitive' },
      });
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

      await controller.jobSearch(reqFor('w1') as never, { sort: 'amount_desc' });
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
        address: { contains: 'Bacongo', mode: 'insensitive' },
        payment_flow: 'DAILY',
        amount: { gte: 5000 },
        applications: { none: { worker_id: 'w1' } },
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
      prisma.application.findMany.mockResolvedValue([
        { job_offer_id: 'job-1' },
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
      jobOfferService.findByEmployerId.mockResolvedValue({ items: [{ id: 'o1' }], total: 1 });

      const result = await controller.myJobOffers(reqFor('e1') as never);

      expect(jobOfferService.findByEmployerId).toHaveBeenCalledWith('e1', {
        page: 0,
        pageSize: 20,
      });
      expect(result).toEqual({ items: [{ id: 'o1' }], total: 1 });
    });

    it('403s for a WORKER', async () => {
      mockType(ProfileType.WORKER);
      await expect(controller.myJobOffers(reqFor('w1') as never)).rejects.toThrow(
        ForbiddenException,
      );
      expect(jobOfferService.findByEmployerId).not.toHaveBeenCalled();
    });
  });

  describe('received-applications (EMPLOYER)', () => {
    it('returns applications received', async () => {
      mockType(ProfileType.EMPLOYER);
      applicationService.findByEmployer.mockResolvedValue({ items: [{ id: 'a1' }], total: 1 });

      const result = await controller.receivedApplications(reqFor('e1') as never);

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
