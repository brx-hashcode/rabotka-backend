import { Logger } from '@nestjs/common';
import { RecommendationEngineService } from '../recommendation-engine.service';
import { EMPTY_FEATURES, type UserFeatures } from '../user-feature.service';
import { COLLECTIONS } from '../../qdrant/qdrant.config';
import { jobCategories } from '../../matching/job-categories';

// The offer's trades: its own category, else whatever the test says the title
// names (`guessed`).
let guessed: string[] = [];
jest.mock('../../matching/job-categories', () => ({
  jobCategories: jest.fn(),
}));
const jobCategoriesMock = jobCategories as jest.MockedFunction<
  typeof jobCategories
>;

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const OFFER_ID = 'offer-1';
const EMPLOYER_ID = 'emp-1';

const features = (over: Partial<UserFeatures> = {}): UserFeatures => ({
  ...EMPTY_FEATURES,
  ...over,
});

const worker = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  categoryIds: ['cat-a'],
  latitude: null,
  longitude: null,
  countryCode: null,
  city: null,
  createdAt: new Date(Date.now() - 86_400_000),
  ...over,
});

const offerRow = (over: Record<string, unknown> = {}) => ({
  id: OFFER_ID,
  employer_id: EMPLOYER_ID,
  category_id: 'cat-a',
  is_remote: false,
  latitude: null,
  longitude: null,
  country_code: 'CG',
  city: 'Brazzaville',
  ...over,
});

function makeDeps() {
  const prisma = {
    jobOffer: { findUnique: jest.fn().mockResolvedValue(offerRow()) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    profile: { findUnique: jest.fn().mockResolvedValue(null) },
    profileCategory: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sources = {
    workersFromAffinities: jest.fn().mockResolvedValue([]),
    workersFromCategories: jest.fn().mockResolvedValue([]),
    workersFromAll: jest.fn().mockResolvedValue([]),
    workerQuality: jest.fn().mockResolvedValue(new Map()),
    lastActiveAt: jest.fn().mockResolvedValue(new Map()),
    lastRecommendedAt: jest.fn().mockResolvedValue(new Map()),
    hardBlockedWorkerIds: jest.fn().mockResolvedValue(new Set()),
    similarity: jest.fn().mockResolvedValue(new Map()),
  };
  const featureService = {
    get: jest.fn().mockResolvedValue(features()),
    getMany: jest.fn().mockResolvedValue(new Map()),
  };
  const systemConfig = {
    isSimilarityEnabled: jest.fn().mockResolvedValue(true),
    getRecommendationMinScore: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue('false'),
    getFees: jest.fn().mockResolvedValue({ reliabilityScoreMin: 50 }),
  };
  return { prisma, sources, featureService, systemConfig };
}

describe('recommendWorkersForJobOffer', () => {
  let service: RecommendationEngineService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    guessed = [];
    jobCategoriesMock.mockImplementation((_prisma, offer) =>
      Promise.resolve(offer.category_id ? [offer.category_id] : guessed),
    );
    deps = makeDeps();
    service = new RecommendationEngineService(
      deps.prisma as never,
      deps.sources as never,
      deps.featureService as never,
      deps.systemConfig as never,
    );
  });

  /** Notification settings: empty allowed. */
  const notify = (limit = 10, over: Record<string, unknown> = {}) =>
    service.recommendWorkersForJobOffer(OFFER_ID, limit, {
      keepAtLeast: 0,
      ...over,
    });

  const withWorkers = (...ids: string[]) => {
    deps.sources.workersFromCategories.mockResolvedValue(
      ids.map((id) => worker(id)),
    );
  };

  describe('urgency is deliberately absent', () => {
    it('scores identically however soon the offer starts', async () => {
      // Urgency belongs to the OFFER, so in this direction it is the same
      // number for every candidate. `computeRelevance` is a weighted mean, so a
      // constant term does not cancel — it would shift every score by the same
      // amount while ordering nothing, moving the whole set across the
      // notification threshold. A distant offer would silently notify no one.
      //
      // If someone adds an `urgency` term back, this test is what fails.
      withWorkers('w1', 'w2', 'w3');

      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ scheduled_at: new Date(Date.now() + 3_600_000) }),
      );
      const imminent = await notify();

      jest.clearAllMocks();
      deps = { ...deps };
      withWorkers('w1', 'w2', 'w3');
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ scheduled_at: new Date(Date.now() + 30 * 86_400_000) }),
      );
      const distant = await notify();

      expect(distant.map((r) => r.score)).toEqual(imminent.map((r) => r.score));
    });
  });

  describe('proximity', () => {
    it('is dropped entirely for a remote offer', async () => {
      // Distance is meaningless for remote work, not merely unknown. A remote
      // offer must not score differently from a located one purely because of
      // where the candidates happen to live.
      withWorkers('near', 'far');
      deps.featureService.getMany.mockResolvedValue(
        new Map([
          ['near', features()],
          ['far', features()],
        ]),
      );

      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ is_remote: true }),
      );
      const remote = await notify();

      expect(remote).toHaveLength(2);
      // With prox dropped, two otherwise-identical workers tie.
      expect(remote[0].score).toBeCloseTo(remote[1].score, 10);
    });

    it('falls back to declared city and country when there are no coordinates', async () => {
      // The offer carries no lat/lng — nothing geocodes on create any more — so
      // the graded city/country score is the live path, not an edge case.
      deps.sources.workersFromCategories.mockResolvedValue([
        worker('same-city', { countryCode: 'CG', city: 'Brazzaville' }),
        worker('other-country', { countryCode: 'FR', city: 'Paris' }),
      ]);
      deps.featureService.getMany.mockResolvedValue(
        new Map([
          ['same-city', features()],
          ['other-country', features()],
        ]),
      );

      const ranked = await notify();

      expect(ranked[0].id).toBe('same-city');
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('measures against each worker’s own learned distance tolerance', async () => {
      // Same haversine distance, different half-lives: a worker who habitually
      // travels must not be scored on a global 5 km assumption.
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ latitude: -4.26, longitude: 15.28 }),
      );
      deps.sources.workersFromCategories.mockResolvedValue([
        worker('commuter', { latitude: -4.35, longitude: 15.28 }),
        worker('homebody', { latitude: -4.35, longitude: 15.28 }),
      ]);
      deps.featureService.getMany.mockResolvedValue(
        new Map([
          ['commuter', features({ distanceHalfLifeKm: 40 })],
          ['homebody', features({ distanceHalfLifeKm: 2 })],
        ]),
      );

      const ranked = await notify();
      const byId = new Map(ranked.map((r) => [r.id, r.score]));

      expect(byId.get('commuter')!).toBeGreaterThan(byId.get('homebody')!);
    });
  });

  describe('thresholding', () => {
    it('returns nothing when nobody clears the bar', async () => {
      // The anti-invariant: for a push notification, zero is a correct answer.
      withWorkers('w1', 'w2');

      expect(await notify(10, { minScore: 0.99 })).toEqual([]);
    });

    it('still never empties for a feed-style caller', async () => {
      // `applyThreshold`'s floor must survive for everyone who did not opt out.
      withWorkers('w1', 'w2');

      const ranked = await service.recommendWorkersForJobOffer(OFFER_ID, 10, {
        minScore: 0.99,
      });

      expect(ranked.length).toBeGreaterThan(0);
    });
  });

  describe('candidate sourcing', () => {
    it('never widens to all workers for a categorised offer', async () => {
      // On a feed an irrelevant profile costs a scroll; here it costs a real
      // WhatsApp message and an hour of that worker's quota.
      withWorkers('w1');

      await notify();

      expect(deps.sources.workersFromCategories).toHaveBeenCalledWith(
        ['cat-a'],
        expect.anything(),
        10,
      );
      expect(deps.sources.workersFromAll).not.toHaveBeenCalled();
    });

    it('takes an uncategorised offer to the trades its title names', async () => {
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ category_id: null, title: 'Réparation télévision' }),
      );
      guessed = ['cat-repair'];
      deps.sources.workersFromCategories.mockResolvedValue([
        worker('fixer', { categoryIds: ['cat-repair'] }),
      ]);

      const ranked = await notify();

      expect(deps.sources.workersFromCategories).toHaveBeenCalledWith(
        ['cat-repair'],
        expect.anything(),
        10,
      );
      expect(ranked.map((r) => r.id)).toEqual(['fixer']);
      expect(deps.sources.workersFromAll).not.toHaveBeenCalled();
    });

    it('suggests no one when the trade cannot be told', async () => {
      // Nursing students for a TV repair was the bug: no suggestion beats an
      // unrelated one, for the agent calling and the worker messaged alike.
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ category_id: null, title: 'Je cherche quelqu’un' }),
      );
      deps.sources.workersFromAll.mockResolvedValue([worker('anyone')]);

      expect(await notify()).toEqual([]);
      expect(deps.sources.workersFromCategories).not.toHaveBeenCalled();
      expect(deps.sources.workersFromAll).not.toHaveBeenCalled();
    });

    it('never draws on the employer’s past hires', async () => {
      withWorkers('w1');
      deps.sources.workersFromAffinities.mockResolvedValue([worker('aide')]);

      const ranked = await notify();

      expect(deps.sources.workersFromAffinities).not.toHaveBeenCalled();
      expect(ranked.map((r) => r.id)).toEqual(['w1']);
    });

    it('excludes workers who already applied', async () => {
      deps.prisma.application.findMany.mockResolvedValue([
        { worker_id: 'already-applied' },
      ]);
      withWorkers('w1');

      await notify();

      const [, opts] = deps.sources.workersFromCategories.mock.calls[0];
      expect([...opts.exclude]).toContain('already-applied');
    });

    it('passes the KYC requirement down to the candidate query', async () => {
      withWorkers('w1');

      await notify(10, { requireVerified: false });

      const [, opts] = deps.sources.workersFromCategories.mock.calls[0];
      expect(opts.requireVerified).toBe(false);
    });

    it("keeps candidates to where the job is done, the offer's place first", async () => {
      withWorkers('w1');

      await notify();

      const [, opts] = deps.sources.workersFromCategories.mock.calls[0];
      expect(opts.near).toEqual({ countryCode: 'CG', city: 'Brazzaville' });
    });

    it("falls back to the employer's place when the offer names none", async () => {
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({
          country_code: null,
          city: null,
          employer: { country_code: 'CM', city: 'Douala' },
        }),
      );
      withWorkers('w1');

      await notify();

      const [, opts] = deps.sources.workersFromCategories.mock.calls[0];
      expect(opts.near).toEqual({ countryCode: 'CM', city: 'Douala' });
    });

    it('tells anyone about a remote job', async () => {
      deps.prisma.jobOffer.findUnique.mockResolvedValue(
        offerRow({ is_remote: true }),
      );
      withWorkers('w1');

      await notify();

      const [, opts] = deps.sources.workersFromCategories.mock.calls[0];
      expect(opts.near).toBeNull();
    });

    it('drops hard-blocked workers after fusion', async () => {
      withWorkers('ok', 'blocked');
      deps.sources.hardBlockedWorkerIds.mockResolvedValue(new Set(['blocked']));

      const ranked = await notify();

      expect(ranked.map((r) => r.id)).toEqual(['ok']);
    });

    it('returns nothing when no tier yields a candidate', async () => {
      expect(await notify()).toEqual([]);
    });

    it('returns nothing when the offer does not exist', async () => {
      deps.prisma.jobOffer.findUnique.mockResolvedValue(null);

      expect(await notify()).toEqual([]);
    });
  });

  describe('penalties', () => {
    it('demotes a worker who keeps rejecting this offer’s category', async () => {
      withWorkers('willing', 'reluctant');
      deps.featureService.getMany.mockResolvedValue(
        new Map([
          ['willing', features()],
          ['reluctant', features({ negativeCategoryIds: ['cat-a'] })],
        ]),
      );

      const ranked = await notify();
      const byId = new Map(ranked.map((r) => [r.id, r.score]));

      expect(byId.get('reluctant')!).toBeLessThan(byId.get('willing')!);
    });

    it('demotes a worker messaged moments ago', async () => {
      // The soft signal that keeps the hard Redis cooldown from having to fire.
      withWorkers('rested', 'just-messaged');
      deps.sources.lastRecommendedAt.mockResolvedValue(
        new Map([['just-messaged', new Date()]]),
      );

      const ranked = await notify();

      expect(ranked[0].id).toBe('rested');
    });
  });

  describe('similarity', () => {
    it('queries offer → workers, the direction a portfolio pays off in', async () => {
      withWorkers('w1');

      await notify();

      const [queryCollection, queryId, candidateCollection] =
        deps.sources.similarity.mock.calls[0];
      expect(queryCollection).toBe(COLLECTIONS.JOBS);
      expect(queryId).toBe(OFFER_ID);
      expect(candidateCollection).toBe(COLLECTIONS.WORKERS);
    });

    it('still ranks when there are no vectors at all', async () => {
      // The regression that matters most: legacy returned `[]` outright with
      // embeddings off, so the whole feature went dark. Here `sim` is simply
      // null and its weight redistributes.
      withWorkers('w1', 'w2');
      deps.sources.similarity.mockResolvedValue(new Map());

      expect(await notify()).toHaveLength(2);
    });
  });

  it('judges candidates on the job, not on what the employer liked before', async () => {
    // Same trade, same everything — except w2 also works in a category this
    // employer has hired in a lot. For THIS job that is no reason to rank w2
    // higher.
    deps.sources.workersFromCategories.mockResolvedValue([
      worker('w1', { categoryIds: ['cat-a'] }),
      worker('w2', { categoryIds: ['cat-a', 'cat-liked'] }),
    ]);
    deps.featureService.get.mockResolvedValue(
      features({
        positiveCount: 50,
        categoryAffinity: { 'cat-liked': 1 },
        counterpartyAffinity: { w2: 1 },
      }),
    );

    const ranked = await notify();

    const score = (id: string) => ranked.find((r) => r.id === id)!.score;
    expect(score('w1')).toBe(score('w2'));
    expect(ranked.find((r) => r.id === 'w2')!.matchScore).toBe(
      ranked.find((r) => r.id === 'w1')!.matchScore,
    );
  });

  it('is deterministic', async () => {
    // Offers never explore: nothing random may be consulted.
    withWorkers('w1', 'w2', 'w3');

    const a = await notify();
    const b = await notify();

    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
  });
});
