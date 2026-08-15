import { Logger } from '@nestjs/common';
import { InteractionKind, JobOfferStatus } from '@prisma/client';
import { CandidateSourceService } from '../candidate-sources';
import { HARD_BLOCK_DAYS } from '../../penalty/penalty.utils';
import { EMPTY_FEATURES, type UserFeatures } from '../user-feature.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  category_id: 'cat-a',
  employer_id: 'emp-1',
  scheduled_at: new Date('2026-08-01T09:00:00Z'),
  created_at: new Date('2026-07-30T09:00:00Z'),
  amount: null,
  payment_flow: null,
  latitude: null,
  longitude: null,
  is_remote: false,
  ...over,
});

const features = (over: Partial<UserFeatures> = {}): UserFeatures => ({
  ...EMPTY_FEATURES,
  ...over,
});

function makePrisma() {
  return {
    jobOffer: { findMany: jest.fn().mockResolvedValue([]) },
    application: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    profile: { findMany: jest.fn().mockResolvedValue([]) },
    interactionEvent: { findMany: jest.fn().mockResolvedValue([]) },
    penalty: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('CandidateSourceService', () => {
  let service: CandidateSourceService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    // Qdrant is only reached by `similarity`, which nothing here exercises —
    // but the argument has to be passed for this to typecheck at all.
    service = new CandidateSourceService(prisma as never, undefined as never);
  });

  describe('fromAffinities', () => {
    it('does not query at all when the user has no learned affinities', async () => {
      const out = await service.fromAffinities('w1', features(), 10);
      expect(out).toEqual([]);
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('queries on categories and employers the user actually engaged with', async () => {
      prisma.jobOffer.findMany.mockResolvedValue([row('o1')]);

      await service.fromAffinities(
        'w1',
        features({
          categoryAffinity: { 'cat-a': 1, 'cat-b': 0.4 },
          counterpartyAffinity: { 'emp-9': 0.8 },
        }),
        10,
      );

      const where = prisma.jobOffer.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { category_id: { in: ['cat-a', 'cat-b'] } },
        { employer_id: { in: ['emp-9'] } },
      ]);
      // Never resurface an offer the worker already acted on.
      expect(where.applications).toEqual({ none: { worker_id: 'w1' } });
      expect(where.status).toEqual({
        in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
      });
    });

    it('drops zero-weight affinity keys rather than querying on them', async () => {
      await service.fromAffinities(
        'w1',
        features({ categoryAffinity: { 'cat-a': 1, 'cat-dead': 0 } }),
        10,
      );

      const where = prisma.jobOffer.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([{ category_id: { in: ['cat-a'] } }]);
    });

    it('excludes categories the user has demonstrably rejected', async () => {
      await service.fromAffinities(
        'w1',
        features({
          categoryAffinity: { 'cat-a': 1 },
          negativeCategoryIds: ['cat-x'],
        }),
        10,
      );

      expect(
        prisma.jobOffer.findMany.mock.calls[0][0].where.category_id,
      ).toEqual({ notIn: ['cat-x'] });
    });

    it('caps how many affinity keys reach the query', async () => {
      const many = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`cat-${i}`, 1 - i / 100]),
      );
      await service.fromAffinities(
        'w1',
        features({ categoryAffinity: many }),
        10,
      );

      const or = prisma.jobOffer.findMany.mock.calls[0][0].where.OR;
      expect(or[0].category_id.in).toHaveLength(12);
      // Highest-weighted keys survive the cap.
      expect(or[0].category_id.in[0]).toBe('cat-0');
    });

    it('over-fetches so downstream filtering can still yield topN', async () => {
      await service.fromAffinities(
        'w1',
        features({ categoryAffinity: { 'cat-a': 1 } }),
        10,
      );
      expect(prisma.jobOffer.findMany.mock.calls[0][0].take).toBe(40);
    });

    it('maps Decimal amounts to plain numbers', async () => {
      prisma.jobOffer.findMany.mockResolvedValue([
        row('o1', { amount: { toString: () => '7500' } }),
      ]);
      const [c] = await service.fromAffinities(
        'w1',
        features({ categoryAffinity: { 'cat-a': 1 } }),
        10,
      );
      expect(c.amount).toBe(7500);
    });
  });

  /**
   * Where a job offer's location comes from.
   *
   * Offers only gained country/city after profiles did, so both sources exist
   * and the precedence between them decides whether an employer who recruits
   * away from their own base is ranked against the right city.
   */
  describe('offer location', () => {
    const locate = async (over: Record<string, unknown>) => {
      prisma.jobOffer.findMany.mockResolvedValue([row('o1', over)]);
      const [candidate] = await service.fromAllOpen('w1', 10);
      return candidate;
    };

    it("prefers the offer's own location over the employer's", async () => {
      const c = await locate({
        country_code: 'CG',
        city: 'Pointe-Noire',
        employer: { country_code: 'CG', city: 'Brazzaville' },
      });

      expect(c.city).toBe('Pointe-Noire');
      expect(c.countryCode).toBe('CG');
    });

    it('falls back to the employer for offers created before the columns existed', async () => {
      const c = await locate({
        country_code: null,
        city: null,
        employer: { country_code: 'CG', city: 'Brazzaville' },
      });

      expect(c.city).toBe('Brazzaville');
      expect(c.countryCode).toBe('CG');
    });

    it('reports no location when neither side has one', async () => {
      const c = await locate({
        country_code: null,
        city: null,
        employer: null,
      });

      expect(c.city).toBeNull();
      expect(c.countryCode).toBeNull();
    });
  });

  describe('fromCollaborativeFiltering', () => {
    const warm = features({ categoryAffinity: { 'cat-a': 1 } });

    it('is a no-op without seed categories', async () => {
      const out = await service.fromCollaborativeFiltering(
        'w1',
        features(),
        10,
      );
      expect(out).toEqual([]);
      expect(prisma.application.findMany).not.toHaveBeenCalled();
    });

    it('returns nothing when no peer worked the same categories', async () => {
      prisma.application.findMany.mockResolvedValue([]);
      expect(await service.fromCollaborativeFiltering('w1', warm, 10)).toEqual(
        [],
      );
      expect(prisma.application.groupBy).not.toHaveBeenCalled();
    });

    it('excludes the user themselves from the peer set', async () => {
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);
      await service.fromCollaborativeFiltering('w1', warm, 10);
      expect(
        prisma.application.findMany.mock.calls[0][0].where.worker_id,
      ).toEqual({ not: 'w1' });
    });

    it('discards co-occurrences below the support floor', async () => {
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);
      prisma.application.groupBy.mockResolvedValue([
        { job_offer_id: 'o-strong', _count: { _all: 2 } },
        { job_offer_id: 'o-noise', _count: { _all: 1 } },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([
        row('o-strong'),
        row('o-noise'),
      ]);

      const out = await service.fromCollaborativeFiltering('w1', warm, 10);
      expect(out.map((c) => c.id)).toEqual(['o-strong']);
    });

    it('preserves co-occurrence order that the id-set hydration loses', async () => {
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);
      prisma.application.groupBy.mockResolvedValue([
        { job_offer_id: 'o1', _count: { _all: 5 } },
        { job_offer_id: 'o2', _count: { _all: 3 } },
        { job_offer_id: 'o3', _count: { _all: 2 } },
      ]);
      // Deliberately shuffled — Prisma gives no ordering guarantee for `in`.
      prisma.jobOffer.findMany.mockResolvedValue([
        row('o3'),
        row('o1'),
        row('o2'),
      ]);

      const out = await service.fromCollaborativeFiltering('w1', warm, 10);
      expect(out.map((c) => c.id)).toEqual(['o1', 'o2', 'o3']);
    });

    it('drops ids that are no longer open when hydrated', async () => {
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);
      prisma.application.groupBy.mockResolvedValue([
        { job_offer_id: 'o1', _count: { _all: 4 } },
        { job_offer_id: 'o-closed', _count: { _all: 4 } },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([row('o1')]);

      const out = await service.fromCollaborativeFiltering('w1', warm, 10);
      expect(out.map((c) => c.id)).toEqual(['o1']);
    });

    it('excludes seed and negative categories from the discovery query', async () => {
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w2' }]);
      await service.fromCollaborativeFiltering(
        'w1',
        features({
          categoryAffinity: { 'cat-a': 1 },
          negativeCategoryIds: ['cat-x'],
        }),
        10,
      );
      expect(
        prisma.application.groupBy.mock.calls[0][0].where.job_offer.category_id,
      ).toEqual({ notIn: ['cat-a', 'cat-x'] });
    });

    it('degrades to an empty pool instead of throwing', async () => {
      prisma.application.findMany.mockRejectedValue(new Error('db down'));
      expect(await service.fromCollaborativeFiltering('w1', warm, 10)).toEqual(
        [],
      );
    });
  });

  describe('fromDeclaredCategories / fromAllOpen', () => {
    it('skips the query when the worker declared no categories', async () => {
      expect(await service.fromDeclaredCategories('w1', [], 10)).toEqual([]);
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });

    it('always excludes already-applied offers in the last-resort tier', async () => {
      await service.fromAllOpen('w1', 10);
      expect(
        prisma.jobOffer.findMany.mock.calls[0][0].where.applications,
      ).toEqual({ none: { worker_id: 'w1' } });
    });
  });

  describe('employerQuality', () => {
    it('returns an empty map for an empty batch without querying', async () => {
      expect((await service.employerQuality([])).size).toBe(0);
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('scores a perfect employer at 1 and a worst-case one at 0', async () => {
      prisma.profile.findMany.mockResolvedValue([
        { id: 'best', reliability_score: 100, rating_avg: 5 },
        { id: 'worst', reliability_score: 0, rating_avg: 1 },
      ]);
      const q = await service.employerQuality(['best', 'worst']);
      expect(q.get('best')).toBeCloseTo(1, 6);
      expect(q.get('worst')).toBeCloseTo(0, 6);
    });

    it('treats a missing rating as neutral rather than as zero', async () => {
      prisma.profile.findMany.mockResolvedValue([
        { id: 'e1', reliability_score: 100, rating_avg: null },
      ]);
      // 0.6 * 1 + 0.4 * 0.5
      expect((await service.employerQuality(['e1'])).get('e1')).toBeCloseTo(
        0.8,
        6,
      );
    });

    it('assumes a full reliability score when none is recorded', async () => {
      prisma.profile.findMany.mockResolvedValue([
        { id: 'e1', reliability_score: null, rating_avg: 3 },
      ]);
      // 0.6 * 1 + 0.4 * 0.5
      expect((await service.employerQuality(['e1'])).get('e1')).toBeCloseTo(
        0.8,
        6,
      );
    });

    it('keeps every score inside [0,1] for out-of-range stored values', async () => {
      prisma.profile.findMany.mockResolvedValue([
        { id: 'over', reliability_score: 250, rating_avg: 5 },
        { id: 'under', reliability_score: -40, rating_avg: 1 },
      ]);
      const q = await service.employerQuality(['over', 'under']);
      for (const v of q.values()) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('degrades to an empty map rather than failing the whole request', async () => {
      prisma.profile.findMany.mockRejectedValue(new Error('db down'));
      expect((await service.employerQuality(['e1'])).size).toBe(0);
    });
  });

  describe('lastSeenAt', () => {
    it('keeps only the most recent sighting per offer', async () => {
      const recent = new Date('2026-07-30T12:00:00Z');
      prisma.interactionEvent.findMany.mockResolvedValue([
        { object_id: 'o1', occurred_at: recent },
        { object_id: 'o1', occurred_at: new Date('2026-07-20T12:00:00Z') },
      ]);
      const seen = await service.lastSeenAt('w1', ['o1']);
      expect(seen.get('o1')).toEqual(recent);
    });

    it('ignores rows with a null object id', async () => {
      prisma.interactionEvent.findMany.mockResolvedValue([
        { object_id: null, occurred_at: new Date() },
      ]);
      expect((await service.lastSeenAt('w1', ['o1'])).size).toBe(0);
    });

    it('degrades to no suppression rather than failing', async () => {
      prisma.interactionEvent.findMany.mockRejectedValue(new Error('db down'));
      expect((await service.lastSeenAt('w1', ['o1'])).size).toBe(0);
    });
  });

  describe('unsavedOfferIds', () => {
    it('collects only UNSAVE events', async () => {
      prisma.interactionEvent.findMany.mockResolvedValue([{ object_id: 'o1' }]);
      const out = await service.unsavedOfferIds('w1', ['o1', 'o2']);
      expect(prisma.interactionEvent.findMany.mock.calls[0][0].where.kind).toBe(
        'UNSAVE',
      );
      expect([...out]).toEqual(['o1']);
    });

    it('degrades to an empty set rather than failing', async () => {
      prisma.interactionEvent.findMany.mockRejectedValue(new Error('db down'));
      expect((await service.unsavedOfferIds('w1', ['o1'])).size).toBe(0);
    });
  });

  describe('worker sources (employer side)', () => {
    const opts = { reliabilityMin: 50, exclude: new Set<string>() };
    const workerRow = (id: string, cats: string[] = ['cat-a']) => ({
      id,
      latitude: null,
      longitude: null,
      created_at: new Date('2026-07-01T00:00:00Z'),
      categories: cats.map((c) => ({ category_id: c })),
    });

    it('applies the full eligibility predicate', async () => {
      await service.workersFromAll(opts, 10);
      const where = prisma.profile.findMany.mock.calls[0][0].where;
      expect(where.profile_type).toBe('WORKER');
      expect(where.status).toBe('ACTIVE');
      expect(where.verification_status).toBe('VERIFIED');
      expect(where.deleted_at).toBeNull();
      expect(where.reliability_score).toEqual({ gte: 50 });
    });

    it('omits the exclusion clause entirely when nothing is excluded', async () => {
      await service.workersFromAll(opts, 10);
      expect(prisma.profile.findMany.mock.calls[0][0].where.id).toBeUndefined();
    });

    it('excludes already-contacted workers', async () => {
      await service.workersFromAll(
        { reliabilityMin: 50, exclude: new Set(['w-contacted']) },
        10,
      );
      expect(prisma.profile.findMany.mock.calls[0][0].where.id).toEqual({
        notIn: ['w-contacted'],
      });
    });

    it('does not query without learned affinities', async () => {
      const out = await service.workersFromAffinities(features(), opts, 10);
      expect(out).toEqual([]);
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it("narrows to the employer's high-affinity trades", async () => {
      await service.workersFromAffinities(
        features({ categoryAffinity: { 'cat-a': 1, 'cat-b': 0.5 } }),
        opts,
        10,
      );
      expect(prisma.profile.findMany.mock.calls[0][0].where.categories).toEqual(
        { some: { category_id: { in: ['cat-a', 'cat-b'] } } },
      );
    });

    it("flattens a worker's categories onto the candidate", async () => {
      prisma.profile.findMany.mockResolvedValue([
        workerRow('w1', ['cat-a', 'cat-b']),
      ]);
      const [c] = await service.workersFromAll(opts, 10);
      expect(c.categoryIds).toEqual(['cat-a', 'cat-b']);
    });

    it('skips the query when the employer has no offer categories', async () => {
      expect(await service.workersFromCategories([], opts, 10)).toEqual([]);
      expect(prisma.profile.findMany).not.toHaveBeenCalled();
    });

    it('orders by reliability then rating', async () => {
      await service.workersFromAll(opts, 10);
      expect(prisma.profile.findMany.mock.calls[0][0].orderBy).toEqual([
        { reliability_score: 'desc' },
        { rating_avg: 'desc' },
      ]);
    });
  });

  describe('lastActiveAt', () => {
    it('keeps only the most recent activity per worker', async () => {
      const recent = new Date('2026-07-30T12:00:00Z');
      prisma.interactionEvent.findMany.mockResolvedValue([
        { actor_id: 'w1', occurred_at: recent },
        { actor_id: 'w1', occurred_at: new Date('2026-07-01T12:00:00Z') },
      ]);
      expect((await service.lastActiveAt(['w1'])).get('w1')).toEqual(recent);
    });

    it('leaves a never-active worker absent rather than dated', async () => {
      prisma.interactionEvent.findMany.mockResolvedValue([]);
      expect((await service.lastActiveAt(['w1'])).has('w1')).toBe(false);
    });

    it('degrades to an empty map rather than failing', async () => {
      prisma.interactionEvent.findMany.mockRejectedValue(new Error('down'));
      expect((await service.lastActiveAt(['w1'])).size).toBe(0);
    });
  });

  describe('lastRecommendedAt', () => {
    it('does not query for an empty batch', async () => {
      expect((await service.lastRecommendedAt([])).size).toBe(0);
      expect(prisma.interactionEvent.findMany).not.toHaveBeenCalled();
    });

    it('asks only for recommendations actually served', async () => {
      await service.lastRecommendedAt(['w1']);

      const [{ where }] = prisma.interactionEvent.findMany.mock.calls[0];
      expect(where.kind).toBe(InteractionKind.RECOMMENDATION_SERVED);
      expect(where.actor_id).toEqual({ in: ['w1'] });
    });

    it('keeps the most recent per worker', async () => {
      // Keyed by actor across every offer — the question is how recently this
      // person was messaged at all, not whether they saw one particular job.
      const recent = new Date('2026-07-30T12:00:00Z');
      prisma.interactionEvent.findMany.mockResolvedValue([
        { actor_id: 'w1', occurred_at: recent },
        { actor_id: 'w1', occurred_at: new Date('2026-07-01T12:00:00Z') },
      ]);

      expect((await service.lastRecommendedAt(['w1'])).get('w1')).toEqual(
        recent,
      );
    });

    it('leaves a never-messaged worker absent rather than dated', async () => {
      expect((await service.lastRecommendedAt(['w1'])).has('w1')).toBe(false);
    });

    it('degrades to an empty map rather than failing', async () => {
      prisma.interactionEvent.findMany.mockRejectedValue(new Error('down'));
      expect((await service.lastRecommendedAt(['w1'])).size).toBe(0);
    });
  });

  describe('hardBlockedWorkerIds', () => {
    it('does not query for an empty batch', async () => {
      expect((await service.hardBlockedWorkerIds([])).size).toBe(0);
      expect(prisma.penalty.findMany).not.toHaveBeenCalled();
    });

    it('looks only at unpaid penalties older than the hard-block window', async () => {
      await service.hardBlockedWorkerIds(['w1']);

      const [{ where }] = prisma.penalty.findMany.mock.calls[0];
      expect(where.paid_at).toBeNull();
      const cutoff = where.applied_at.lte as Date;
      const daysAgo = (Date.now() - cutoff.getTime()) / 86_400_000;
      expect(daysAgo).toBeCloseTo(HARD_BLOCK_DAYS, 1);
    });

    it('returns the blocked ids', async () => {
      prisma.penalty.findMany.mockResolvedValue([{ profile_id: 'w1' }]);
      expect([...(await service.hardBlockedWorkerIds(['w1', 'w2']))]).toEqual([
        'w1',
      ]);
    });

    it('fails open, so a penalty outage cannot mute the whole fan-out', async () => {
      // Notifying someone who should have been skipped beats notifying no one.
      prisma.penalty.findMany.mockRejectedValue(new Error('down'));
      expect((await service.hardBlockedWorkerIds(['w1'])).size).toBe(0);
    });
  });
});
