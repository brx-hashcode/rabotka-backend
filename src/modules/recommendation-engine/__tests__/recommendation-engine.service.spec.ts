import { Logger } from '@nestjs/common';
import { RecommendationEngineService } from '../recommendation-engine.service';
import type { Candidate } from '../candidate-sources';
import { EMPTY_FEATURES, type UserFeatures } from '../user-feature.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

/**
 * One clock for every fixture in this file.
 *
 * `Date.now()` read per fixture gave each candidate its own millisecond, and
 * two candidates built in the same array literal can straddle a tick on a
 * loaded CI runner. `fresh` and `urgency` are both read off those timestamps,
 * so a 1ms skew is a real score difference — enough to flip an assertion that
 * expects the delivered order preserved, and only ever on CI. Freezing one
 * instant makes the fixtures differ by exactly what each test declares.
 *
 * Frozen at module load, not against the scoring clock: only the DIFFERENCE
 * between candidates orders a feed, and the drift against `Date.now()` inside
 * the service is the test's own runtime — milliseconds, on half-lives of days.
 */
const NOW = Date.now();

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  categoryId: 'cat-a',
  employerId: 'emp-1',
  scheduledAt: new Date(NOW + 86_400_000),
  createdAt: new Date(NOW - 3_600_000),
  amount: null,
  paymentFlow: null,
  latitude: null,
  longitude: null,
  countryCode: null,
  city: null,
  isRemote: false,
  ...over,
});

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
  createdAt: new Date(NOW - 86_400_000),
  ...over,
});

function makeDeps() {
  const prisma = {
    profile: { findUnique: jest.fn().mockResolvedValue(null) },
    profileCategory: { findMany: jest.fn().mockResolvedValue([]) },
    jobOffer: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sources = {
    fromAffinities: jest.fn().mockResolvedValue([]),
    fromCollaborativeFiltering: jest.fn().mockResolvedValue([]),
    fromDeclaredCategories: jest.fn().mockResolvedValue([]),
    fromAllOpen: jest.fn().mockResolvedValue([]),
    employerQuality: jest.fn().mockResolvedValue(new Map()),
    lastSeenAt: jest.fn().mockResolvedValue(new Map()),
    unsavedOfferIds: jest.fn().mockResolvedValue(new Set()),
    workersFromAffinities: jest.fn().mockResolvedValue([]),
    workersFromCategories: jest.fn().mockResolvedValue([]),
    workersFromAll: jest.fn().mockResolvedValue([]),
    workerQuality: jest.fn().mockResolvedValue(new Map()),
    lastActiveAt: jest.fn().mockResolvedValue(new Map()),
    similarity: jest.fn().mockResolvedValue(new Map()),
  };
  const featureService = { get: jest.fn().mockResolvedValue(features()) };
  const systemConfig = {
    // On by default, matching production (`matching.use_embeddings = true`).
    isSimilarityEnabled: jest.fn().mockResolvedValue(true),
    getRecommendationMinScore: jest.fn().mockResolvedValue(0),
    get: jest.fn().mockResolvedValue('false'),
    getFees: jest.fn().mockResolvedValue({ reliabilityScoreMin: 50 }),
  };
  return { prisma, sources, featureService, systemConfig };
}

/** Deterministic rng so epsilon-greedy never makes a test flaky. */
const exploit = () => 0.99;

describe('RecommendationEngineService', () => {
  let service: RecommendationEngineService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = makeDeps();
    service = new RecommendationEngineService(
      deps.prisma as never,
      deps.sources as never,
      deps.featureService as never,
      deps.systemConfig as never,
    );
  });

  const recommend = (limit = 10) =>
    service.recommendJobsForWorker('w1', limit, { rng: exploit });

  describe('candidate tiering', () => {
    it('returns an empty feed when every tier is empty', async () => {
      expect(await recommend()).toEqual([]);
    });

    it('never consults the broad tiers when affinities already fill the feed', async () => {
      deps.sources.fromAffinities.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => candidate(`o${i}`)),
      );

      await recommend(5);

      expect(deps.sources.fromDeclaredCategories).not.toHaveBeenCalled();
      expect(deps.sources.fromAllOpen).not.toHaveBeenCalled();
    });

    it('falls through to declared categories when personalization is thin', async () => {
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('o1', { categoryId: 'cat-a', employerId: 'e1' }),
      ]);
      deps.sources.fromDeclaredCategories.mockResolvedValue([
        candidate('o2', { categoryId: 'cat-b', employerId: 'e2' }),
        candidate('o3', { categoryId: 'cat-c', employerId: 'e3' }),
      ]);

      const out = await recommend(3);

      expect(deps.sources.fromDeclaredCategories).toHaveBeenCalled();
      expect(out.map((r) => r.id).sort()).toEqual(['o1', 'o2', 'o3']);
    });

    it('falls all the way through to open offers so a cold user still gets a feed', async () => {
      deps.sources.fromAllOpen.mockResolvedValue([candidate('o1')]);

      const out = await recommend(5);

      expect(out).toHaveLength(1);
      expect(out[0].tier).toBe('all_open');
    });

    it('attributes each result to the first tier that produced it', async () => {
      deps.sources.fromAffinities.mockResolvedValue([candidate('shared')]);
      deps.sources.fromDeclaredCategories.mockResolvedValue([
        candidate('shared'),
        candidate('declared-only'),
      ]);

      const out = await recommend(5);

      expect(out.find((r) => r.id === 'shared')!.tier).toBe('affinity');
      expect(out.find((r) => r.id === 'declared-only')!.tier).toBe('declared');
    });

    it('deduplicates offers appearing in more than one tier', async () => {
      deps.sources.fromAffinities.mockResolvedValue([candidate('o1')]);
      deps.sources.fromDeclaredCategories.mockResolvedValue([candidate('o1')]);

      const out = await recommend(5);
      expect(out.map((r) => r.id)).toEqual(['o1']);
    });

    it('leaves collaborative filtering off unless it is explicitly enabled', async () => {
      deps.sources.fromAllOpen.mockResolvedValue([candidate('o1')]);
      await recommend();
      expect(deps.sources.fromCollaborativeFiltering).not.toHaveBeenCalled();
    });

    it('runs collaborative filtering when the flag is on', async () => {
      deps.systemConfig.get.mockResolvedValue('true');
      deps.sources.fromCollaborativeFiltering.mockResolvedValue([
        candidate('cf1'),
      ]);

      const out = await recommend(5);

      expect(deps.sources.fromCollaborativeFiltering).toHaveBeenCalled();
      expect(out.find((r) => r.id === 'cf1')!.tier).toBe('cf');
    });

    it('keeps the feed alive when the config lookup itself fails', async () => {
      deps.systemConfig.get.mockRejectedValue(new Error('config down'));
      deps.sources.fromAllOpen.mockResolvedValue([candidate('o1')]);

      expect(await recommend()).toHaveLength(1);
    });
  });

  describe('scoring', () => {
    it('drops payFit rather than scoring it as a constant 0.5', async () => {
      // The amount-band / payment-flow affinities are not learned yet, so this
      // term used to return 0.5 for EVERY candidate: no ordering effect, but it
      // consumed weight and pulled every score toward the middle. With it
      // excluded, a candidate whose every applicable term is maxed scores 1.
      deps.featureService.get.mockResolvedValue(
        features({ categoryAffinity: { 'cat-a': 1 } }),
      );
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: -4.26,
        longitude: 15.28,
      });
      deps.sources.fromAllOpen.mockResolvedValue([
        candidate('o1', {
          categoryId: 'cat-a',
          employerId: 'e1',
          latitude: -4.26,
          longitude: 15.28,
          scheduledAt: new Date(NOW + 60_000),
          createdAt: new Date(NOW),
          amount: 12000,
          paymentFlow: 'DAILY',
        }),
      ]);
      deps.sources.employerQuality.mockResolvedValue(new Map([['e1', 1]]));

      const [r] = await recommend(1);
      expect(r.score).toBeCloseTo(1, 2);
    });

    it('keeps every score inside [0,1]', async () => {
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('o1', { categoryId: 'cat-a', employerId: 'e1' }),
        candidate('o2', { categoryId: 'cat-b', employerId: 'e2' }),
        candidate('o3', { categoryId: 'cat-c', employerId: 'e3' }),
      ]);
      deps.sources.employerQuality.mockResolvedValue(
        new Map([
          ['e1', 1],
          ['e2', 0],
          ['e3', 0.5],
        ]),
      );

      for (const r of await recommend(10)) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    // Only guaranteed under pure exploitation: exploration deliberately places
    // lower-scored items high in the feed, since an explore pick buried at the
    // bottom gets no impressions and teaches the ranker nothing.
    it('returns results in descending score order when only exploiting', async () => {
      deps.sources.fromAffinities.mockResolvedValue(
        Array.from({ length: 6 }, (_, i) =>
          candidate(`o${i}`, { categoryId: `cat-${i}`, employerId: `e${i}` }),
        ),
      );

      const scores = (await recommend(6)).map((r) => r.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('ranks an offer in a high-affinity category above one in a cold category', async () => {
      deps.featureService.get.mockResolvedValue(
        features({
          positiveCount: 20,
          categoryAffinity: { hot: 1, cold: 0 },
        }),
      );
      // Same tier and same fused rank input order; only the affinity differs.
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('cold-offer', { categoryId: 'cold', employerId: 'e1' }),
        candidate('hot-offer', { categoryId: 'hot', employerId: 'e2' }),
      ]);

      const out = await recommend(2);
      const hot = out.find((r) => r.id === 'hot-offer')!;
      const cold = out.find((r) => r.id === 'cold-offer')!;
      expect(hot.score).toBeGreaterThan(cold.score);
    });

    it('suppresses — but does not erase — an offer in a rejected category', async () => {
      deps.featureService.get.mockResolvedValue(
        features({ negativeCategoryIds: ['bad'] }),
      );
      deps.sources.fromAllOpen.mockResolvedValue([
        candidate('ok', { categoryId: 'good', employerId: 'e1' }),
        candidate('bad-offer', { categoryId: 'bad', employerId: 'e1' }),
      ]);

      const out = await recommend(5);
      const bad = out.find((r) => r.id === 'bad-offer')!;

      expect(bad).toBeDefined();
      expect(bad.score).toBeLessThan(out.find((r) => r.id === 'ok')!.score);
    });

    it('penalises an offer the worker unsaved', async () => {
      deps.sources.fromAllOpen.mockResolvedValue([
        candidate('kept', { employerId: 'e1' }),
        candidate('dropped', { employerId: 'e2' }),
      ]);
      deps.sources.unsavedOfferIds.mockResolvedValue(new Set(['dropped']));

      const out = await recommend(5);
      expect(out[0].id).toBe('kept');
    });

    it('treats a missing employer-quality entry as neutral rather than zero', async () => {
      deps.sources.fromAllOpen.mockResolvedValue([candidate('o1')]);
      deps.sources.employerQuality.mockResolvedValue(new Map());

      const [r] = await recommend(1);
      expect(r.score).toBeGreaterThan(0);
    });

    it('does not penalise a worker whose profile has no coordinates', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: null,
        longitude: null,
      });
      deps.sources.fromAllOpen.mockResolvedValue([
        candidate('o1', { latitude: -4.26, longitude: 15.28 }),
      ]);

      const [ungeocoded] = await recommend(1);

      // Same setup, but the worker is geocoded right next to the offer.
      jest.clearAllMocks();
      deps.featureService.get.mockResolvedValue(features());
      deps.systemConfig.getRecommendationMinScore.mockResolvedValue(0);
      deps.systemConfig.get.mockResolvedValue('false');
      deps.sources.employerQuality.mockResolvedValue(new Map());
      deps.sources.lastSeenAt.mockResolvedValue(new Map());
      deps.sources.unsavedOfferIds.mockResolvedValue(new Set());
      deps.sources.fromAffinities.mockResolvedValue([]);
      deps.sources.fromDeclaredCategories.mockResolvedValue([]);
      deps.prisma.profileCategory.findMany.mockResolvedValue([]);
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: -4.26,
        longitude: 15.28,
      });
      deps.sources.fromAllOpen.mockResolvedValue([
        candidate('o1', { latitude: -4.26, longitude: 15.28 }),
      ]);

      const [colocated] = await recommend(1);

      // Neutral, so strictly between "no idea" and "right next door".
      expect(ungeocoded.score).toBeLessThan(colocated.score);
      expect(ungeocoded.score).toBeGreaterThan(0);
    });
  });

  describe('thresholding', () => {
    it('never lets the threshold shrink the feed below the requested size', async () => {
      deps.systemConfig.getRecommendationMinScore.mockResolvedValue(1);
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) =>
          candidate(`o${i}`, { categoryId: `cat-${i}`, employerId: `e${i}` }),
        ),
      );

      expect(await recommend(5)).toHaveLength(5);
    });

    it('returns everything available when the pool is smaller than topN', async () => {
      deps.systemConfig.getRecommendationMinScore.mockResolvedValue(1);
      deps.sources.fromAllOpen.mockResolvedValue([candidate('o1')]);

      expect(await recommend(10)).toHaveLength(1);
    });

    it('drops sub-threshold results once the pool is comfortably large', async () => {
      deps.featureService.get.mockResolvedValue(
        features({ negativeCategoryIds: ['bad'] }),
      );
      deps.systemConfig.getRecommendationMinScore.mockResolvedValue(0.5);
      deps.sources.fromAllOpen.mockResolvedValue([
        ...Array.from({ length: 4 }, (_, i) =>
          candidate(`good${i}`, {
            categoryId: `cat-${i}`,
            employerId: `e${i}`,
          }),
        ),
        candidate('bad-offer', { categoryId: 'bad', employerId: 'e9' }),
      ]);

      const out = await recommend(2);
      expect(out.map((r) => r.id)).not.toContain('bad-offer');
    });
  });

  describe('diversity', () => {
    it('spreads a feed across categories when supply allows', async () => {
      // 30 offers over 6 categories: the cap of 3 can be honoured in full.
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) =>
          candidate(`o${i}`, {
            categoryId: `cat-${i % 6}`,
            employerId: `e${i}`,
          }),
        ),
      );

      const out = await recommend(12);
      const perCategory = new Map<string, number>();
      for (const r of out) {
        const cat = `cat-${Number(r.id.slice(1)) % 6}`;
        perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
      }
      for (const n of perCategory.values()) expect(n).toBeLessThanOrEqual(3);
    });

    it('does not starve the feed when only one category is available', async () => {
      // The cap is a preference, not a ceiling. A market with a single active
      // category must still return a full feed rather than three items.
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) =>
          candidate(`o${i}`, { categoryId: 'cat-a', employerId: `e${i}` }),
        ),
      );

      expect(await recommend(10)).toHaveLength(10);
    });

    it('does not starve the feed when only one employer is active', async () => {
      // This is Rabotka's actual situation today: a handful of open offers from
      // two employers. A hard per-employer cap of 2 would return 2 results.
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) =>
          candidate(`o${i}`, { categoryId: `cat-${i}`, employerId: 'emp-1' }),
        ),
      );

      expect(await recommend(10)).toHaveLength(10);
    });

    it('prefers a varied employer mix before falling back to overflow', async () => {
      // 4 employers × 5 offers, feed of 8: the cap of 2 fits exactly, so every
      // employer should appear and none should exceed 2.
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) =>
          candidate(`o${i}`, {
            categoryId: `cat-${i}`,
            employerId: `e${i % 4}`,
          }),
        ),
      );

      const out = await recommend(8);
      const perEmployer = new Map<string, number>();
      for (const r of out) {
        const emp = `e${Number(r.id.slice(1)) % 4}`;
        perEmployer.set(emp, (perEmployer.get(emp) ?? 0) + 1);
      }
      expect(out).toHaveLength(8);
      expect(perEmployer.size).toBe(4);
      for (const n of perEmployer.values()) expect(n).toBeLessThanOrEqual(2);
    });

    it('fills the feed when categories and employers are varied', async () => {
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) =>
          candidate(`o${i}`, { categoryId: `cat-${i}`, employerId: `e${i}` }),
        ),
      );

      expect(await recommend(6)).toHaveLength(6);
    });

    it('never exceeds the requested limit', async () => {
      deps.sources.fromAllOpen.mockResolvedValue(
        Array.from({ length: 40 }, (_, i) =>
          candidate(`o${i}`, { categoryId: `cat-${i}`, employerId: `e${i}` }),
        ),
      );

      expect(await recommend(7)).toHaveLength(7);
    });
  });

  describe('exploration', () => {
    /**
     * Staggered `createdAt` so freshness separates every candidate by a clear
     * margin. With identical timestamps the scores tie, and a tie is broken by
     * sort stability rather than by the selection strategy — which is not what
     * these tests are about.
     */
    const spread = () =>
      Array.from({ length: 12 }, (_, i) =>
        candidate(`o${i}`, {
          categoryId: `cat-${i}`,
          employerId: `e${i}`,
          createdAt: new Date(NOW - i * 12 * 3_600_000),
        }),
      );

    it('is deterministic when the rng always exploits', async () => {
      deps.sources.fromAllOpen.mockResolvedValue(spread());

      const a = await service.recommendJobsForWorker('w1', 5, { rng: exploit });
      const b = await service.recommendJobsForWorker('w1', 5, { rng: exploit });
      expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    });

    it('takes the top-scoring offers when the rng always exploits', async () => {
      deps.sources.fromAllOpen.mockResolvedValue(spread());

      const out = await service.recommendJobsForWorker('w1', 5, {
        rng: exploit,
      });
      expect(out.map((r) => r.id)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    });

    it('surfaces lower-ranked offers when the rng always explores', async () => {
      deps.sources.fromAllOpen.mockResolvedValue(spread());

      const greedy = await service.recommendJobsForWorker('w1', 5, {
        rng: exploit,
      });
      const exploring = await service.recommendJobsForWorker('w1', 5, {
        rng: () => 0,
      });

      expect(exploring).toHaveLength(5);
      expect(exploring.map((r) => r.id)).not.toEqual(greedy.map((r) => r.id));
    });
  });
  /**
   * Proximity used to collapse to a flat 0.5 whenever either side lacked
   * coordinates. `prox` carries 0.35 of the cold-start weight — the heaviest
   * term there is — so for anyone whose fire-and-forget geocoding had failed,
   * a third of the ranking was a constant that ordered nothing.
   */
  describe('proximity falls back to declared country/city', () => {
    const brazzaville = {
      latitude: null,
      longitude: null,
      country_code: 'CG',
      city: 'Brazzaville',
    };

    it('ranks a same-city offer above one merely in the same country', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(brazzaville);
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('far', { countryCode: 'CG', city: 'Pointe-Noire' }),
        candidate('near', { countryCode: 'CG', city: 'Brazzaville' }),
      ]);

      const out = await recommend(2);

      // Both arrive from one source with `far` ranked first by the fuser, so
      // only proximity can put `near` on top.
      expect(out[0].id).toBe('near');
    });

    it('ranks a domestic offer above a foreign one', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue(brazzaville);
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('abroad', { countryCode: 'FR', city: 'Paris' }),
        candidate('home', { countryCode: 'CG', city: 'Owando' }),
      ]);

      expect((await recommend(2))[0].id).toBe('home');
    });

    it('leaves geocoded candidates on the haversine path', async () => {
      // The regression that would matter most: quietly degrading users who
      // already rank correctly. `close` is ~1 km away and in a DIFFERENT
      // country; if the coarse fallback were consulted it would lose.
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: -4.2634,
        longitude: 15.2429,
        country_code: 'CG',
        city: 'Brazzaville',
      });
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('sameCityFarAway', {
          latitude: -4.7889,
          longitude: 11.8636,
          countryCode: 'CG',
          city: 'Brazzaville',
        }),
        candidate('close', {
          latitude: -4.2723,
          longitude: 15.2429,
          countryCode: 'CD',
          city: 'Kinshasa',
        }),
      ]);

      expect((await recommend(2))[0].id).toBe('close');
    });

    it('drops distance entirely for a remote job', async () => {
      // Not 0.5. A remote job is not "distance unknown", it is "distance
      // irrelevant" — a constant would drag every remote offer toward the
      // middle against local work while ordering nothing between them.
      deps.prisma.profile.findUnique.mockResolvedValue(brazzaville);
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('remote', { isRemote: true, countryCode: null, city: null }),
        candidate('abroad', { countryCode: 'FR', city: 'Paris' }),
      ]);

      // With prox dropped, `remote` is scored on the terms that do carry
      // information and beats a job on the other side of the world.
      expect((await recommend(2))[0].id).toBe('remote');
    });

    /**
     * Semantic similarity — the term that carries a worker's portfolio.
     *
     * Realizations are part of the text MatchingService embeds, so wiring `sim`
     * is what makes them count. It was hardcoded null, and since
     * computeRelevance silently drops nulls and redistributes their weight,
     * nothing errored — the signal just never arrived.
     */
    describe('similarity', () => {
      it('orders by similarity when nothing else separates candidates', async () => {
        // A WARM user: `sim` carries 0 weight for a cold one by design, so a
        // cold fixture would pass whatever the wiring did.
        deps.featureService.get.mockResolvedValue(
          features({ positiveCount: 50 }),
        );
        // Identical in every other respect and delivered in the losing order,
        // so only `sim` can put `close` on top. Proves the score is actually
        // consumed rather than merely computed.
        deps.sources.fromAffinities.mockResolvedValue([
          candidate('far'),
          candidate('close'),
        ]);
        deps.sources.similarity.mockResolvedValue(
          new Map([
            ['far', 0.55],
            ['close', 0.95],
          ]),
        );

        expect((await recommend(2))[0].id).toBe('close');
      });

      it('treats a missing score as no evidence, not as zero', async () => {
        // `0` would actively bury a worker who simply has not been indexed
        // yet. Null drops the term and redistributes its weight instead, so an
        // unindexed candidate can still win on everything else.
        deps.featureService.get.mockResolvedValue(
          features({ positiveCount: 50, categoryAffinity: { 'cat-hot': 1 } }),
        );
        deps.sources.fromAffinities.mockResolvedValue([
          candidate('unindexed', { categoryId: 'cat-hot' }),
          candidate('indexed'),
        ]);
        deps.sources.similarity.mockResolvedValue(new Map([['indexed', 0.6]]));

        expect((await recommend(2))[0].id).toBe('unindexed');
      });

      it('keeps the feed when the similarity lookup fails', async () => {
        // Degrade the ranking, never empty the feed.
        deps.sources.similarity.mockRejectedValue(new Error('qdrant down'));
        deps.sources.fromAffinities.mockResolvedValue([
          candidate('a'),
          candidate('b'),
        ]);

        expect(await recommend(2)).toHaveLength(2);
      });

      it('makes no Qdrant call when embeddings are switched off', async () => {
        // One flag still disables embeddings everywhere, and it must short
        // circuit before the query rather than discard the result after it.
        deps.systemConfig.isSimilarityEnabled.mockResolvedValue(false);
        deps.sources.fromAffinities.mockResolvedValue([candidate('a')]);

        await recommend(1);

        expect(deps.sources.similarity).not.toHaveBeenCalled();
      });
    });

    it('scores the whole feed against one clock', async () => {
      // The scoring pass used to read `Date.now()` per candidate. A tick landing
      // mid-loop then scored a later candidate against a later instant, worth a
      // millisecond of `fresh` and `urgency` — enough to reorder candidates
      // nothing else separates, which is exactly what flipped this file's
      // ordering assertions on CI and never on a quiet machine.
      //
      // A clock that advances on every read is that tick boundary made
      // certain. It fails without the snapshot and passes with it, so this
      // holds the fix rather than merely describing it.
      const t = { ms: Date.now() };
      const advancing = jest
        .spyOn(Date, 'now')
        .mockImplementation(() => t.ms++);
      try {
        deps.prisma.profile.findUnique.mockResolvedValue(null);
        deps.sources.fromAffinities.mockResolvedValue([
          candidate('a'),
          candidate('b'),
        ]);

        expect((await recommend(2)).map((r) => r.id)).toEqual(['a', 'b']);
      } finally {
        advancing.mockRestore();
      }
    });

    it('is unchanged when neither side declared a country', async () => {
      // Nobody who has told us nothing may be moved by this change.
      deps.prisma.profile.findUnique.mockResolvedValue(null);
      deps.sources.fromAffinities.mockResolvedValue([
        candidate('a'),
        candidate('b'),
      ]);

      expect((await recommend(2)).map((r) => r.id)).toEqual(['a', 'b']);
    });
  });
});

describe('RecommendationEngineService.recommendWorkersForEmployer', () => {
  let service: RecommendationEngineService;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = makeDeps();
    service = new RecommendationEngineService(
      deps.prisma as never,
      deps.sources as never,
      deps.featureService as never,
      deps.systemConfig as never,
    );
  });

  const recommend = (limit = 20) =>
    service.recommendWorkersForEmployer('emp-1', limit, { rng: exploit });

  describe('candidate tiering', () => {
    it('returns an empty feed when no worker is eligible', async () => {
      expect(await recommend()).toEqual([]);
    });

    it('skips the broad tiers when affinities already fill the feed', async () => {
      deps.sources.workersFromAffinities.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => worker(`w${i}`)),
      );

      await recommend(5);

      expect(deps.sources.workersFromCategories).not.toHaveBeenCalled();
      expect(deps.sources.workersFromAll).not.toHaveBeenCalled();
    });

    it("falls back to the employer's own offer categories", async () => {
      deps.prisma.jobOffer.findMany.mockResolvedValue([
        { category_id: 'cat-x' },
        { category_id: null },
      ]);
      deps.sources.workersFromCategories.mockResolvedValue([worker('w1')]);

      const out = await recommend(5);

      // Null category ids must never reach the query.
      expect(deps.sources.workersFromCategories).toHaveBeenCalledWith(
        ['cat-x'],
        expect.anything(),
        5,
      );
      expect(out[0].tier).toBe('declared');
    });

    it('falls all the way through so a brand-new employer sees profiles', async () => {
      deps.sources.workersFromAll.mockResolvedValue([worker('w1')]);
      const out = await recommend(5);
      expect(out).toHaveLength(1);
      expect(out[0].tier).toBe('all_open');
    });

    it('passes the reliability floor and exclusion set to every source', async () => {
      const exclude = new Set(['already-contacted']);
      deps.sources.workersFromAll.mockResolvedValue([worker('w1')]);

      await service.recommendWorkersForEmployer('emp-1', 5, {
        exclude,
        rng: exploit,
      });

      expect(deps.sources.workersFromAll).toHaveBeenCalledWith(
        { reliabilityMin: 50, exclude },
        5,
      );
    });

    it('accepts caller-supplied categories without querying for them', async () => {
      deps.sources.workersFromCategories.mockResolvedValue([worker('w1')]);

      await service.recommendWorkersForEmployer('emp-1', 5, {
        categoryIds: ['cat-given'],
        rng: exploit,
      });

      expect(deps.prisma.jobOffer.findMany).not.toHaveBeenCalled();
      expect(deps.sources.workersFromCategories).toHaveBeenCalledWith(
        ['cat-given'],
        expect.anything(),
        5,
      );
    });
  });

  describe('scoring', () => {
    it('keeps every score inside [0,1]', async () => {
      deps.sources.workersFromAll.mockResolvedValue([
        worker('w1', { categoryIds: ['cat-a'] }),
        worker('w2', { categoryIds: ['cat-b'] }),
      ]);
      deps.sources.workerQuality.mockResolvedValue(
        new Map([
          ['w1', 1],
          ['w2', 0],
        ]),
      );

      for (const r of await recommend()) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('reaches a perfect score on the terms that do apply', async () => {
      // `urgency` and `payFit` are null on this side — a worker has no start
      // time and no pay amount. Were they scored as 0 instead of excluded, an
      // otherwise perfect worker would top out around 0.77 and a configured
      // threshold would quietly empty the feed. Every applicable term is maxed
      // here, so the score must be exactly 1.
      deps.featureService.get.mockResolvedValue(
        features({ categoryAffinity: { 'cat-a': 1 } }),
      );
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: -4.26,
        longitude: 15.28,
      });
      deps.sources.workersFromAll.mockResolvedValue([
        worker('w1', { latitude: -4.26, longitude: 15.28 }),
      ]);
      deps.sources.workerQuality.mockResolvedValue(new Map([['w1', 1]]));

      const [r] = await recommend(1);
      expect(r.score).toBeCloseTo(1, 6);
    });

    it('ranks a worker in a high-affinity trade above one in a cold trade', async () => {
      deps.featureService.get.mockResolvedValue(
        features({ positiveCount: 20, categoryAffinity: { hot: 1, cold: 0 } }),
      );
      deps.sources.workersFromAll.mockResolvedValue([
        worker('cold-worker', { categoryIds: ['cold'] }),
        worker('hot-worker', { categoryIds: ['hot'] }),
      ]);

      const out = await recommend(2);
      expect(out.find((r) => r.id === 'hot-worker')!.score).toBeGreaterThan(
        out.find((r) => r.id === 'cold-worker')!.score,
      );
    });

    it('scores a multi-trade worker on their best matching trade', async () => {
      deps.featureService.get.mockResolvedValue(
        features({ positiveCount: 20, categoryAffinity: { plumbing: 1 } }),
      );
      deps.sources.workersFromAll.mockResolvedValue([
        worker('specialist', { categoryIds: ['plumbing'] }),
        // Must not be averaged down by the unrelated second trade.
        worker('generalist', { categoryIds: ['plumbing', 'gardening'] }),
      ]);

      const out = await recommend(2);
      expect(out.find((r) => r.id === 'generalist')!.score).toBeCloseTo(
        out.find((r) => r.id === 'specialist')!.score,
        6,
      );
    });

    it('prefers a recently active worker over a dormant one', async () => {
      deps.sources.workersFromAll.mockResolvedValue([
        worker('dormant', { categoryIds: ['cat-a'] }),
        worker('active', { categoryIds: ['cat-b'] }),
      ]);
      deps.sources.lastActiveAt.mockResolvedValue(
        new Map([
          ['active', new Date(NOW - 3_600_000)],
          ['dormant', new Date(NOW - 90 * 86_400_000)],
        ]),
      );

      const out = await recommend(2);
      expect(out[0].id).toBe('active');
    });

    it('does not punish a brand-new worker for having no activity yet', async () => {
      // Absent activity is no evidence, not bad evidence — scoring it as 0 would
      // make a fresh signup unrankable and never shown, so they never become
      // active. Their score must match a worker whose activity is simply unknown.
      deps.sources.workersFromAll.mockResolvedValue([
        worker('newcomer', { categoryIds: ['cat-a'] }),
        worker('dormant', { categoryIds: ['cat-a'] }),
      ]);
      deps.sources.lastActiveAt.mockResolvedValue(
        new Map([['dormant', new Date(NOW - 200 * 86_400_000)]]),
      );

      const out = await recommend(2);
      expect(out.find((r) => r.id === 'newcomer')!.score).toBeGreaterThan(
        out.find((r) => r.id === 'dormant')!.score,
      );
    });

    it('suppresses a worker whose trade the employer keeps rejecting', async () => {
      deps.featureService.get.mockResolvedValue(
        features({ negativeCategoryIds: ['bad'] }),
      );
      deps.sources.workersFromAll.mockResolvedValue([
        worker('ok', { categoryIds: ['good'] }),
        worker('rejected', { categoryIds: ['bad'] }),
      ]);

      const out = await recommend(5);
      expect(out.find((r) => r.id === 'rejected')!.score).toBeLessThan(
        out.find((r) => r.id === 'ok')!.score,
      );
    });
  });

  describe('thresholding and diversity', () => {
    it('never lets the threshold shrink the feed below the requested size', async () => {
      deps.systemConfig.getRecommendationMinScore.mockResolvedValue(1);
      deps.sources.workersFromAll.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) =>
          worker(`w${i}`, { categoryIds: [`cat-${i}`] }),
        ),
      );

      expect(await recommend(5)).toHaveLength(5);
    });

    it('does not starve the feed when every worker shares one trade', async () => {
      deps.sources.workersFromAll.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) =>
          worker(`w${i}`, { categoryIds: ['cat-a'] }),
        ),
      );

      expect(await recommend(12)).toHaveLength(12);
    });

    it('spreads across trades when the employer hires in several', async () => {
      deps.sources.workersFromAll.mockResolvedValue(
        Array.from({ length: 60 }, (_, i) =>
          worker(`w${i}`, { categoryIds: [`cat-${i % 5}`] }),
        ),
      );

      const out = await recommend(15);
      const perTrade = new Map<string, number>();
      for (const r of out) {
        const t = `cat-${Number(r.id.slice(1)) % 5}`;
        perTrade.set(t, (perTrade.get(t) ?? 0) + 1);
      }
      expect(out).toHaveLength(15);
      // Cap scales with the feed size: max(3, ceil(15/3)) = 5.
      for (const n of perTrade.values()) expect(n).toBeLessThanOrEqual(5);
    });

    it('never exceeds the requested limit', async () => {
      deps.sources.workersFromAll.mockResolvedValue(
        Array.from({ length: 80 }, (_, i) =>
          worker(`w${i}`, { categoryIds: [`cat-${i}`] }),
        ),
      );

      expect(await recommend(7)).toHaveLength(7);
    });
  });
  /**
   * The employer-side mirror. Worth its own test rather than trusting symmetry:
   * this path reads country/city off the WORKER row, a different select from
   * the one the job path uses, so a missing field here would not show up above.
   */
  describe('proximity falls back to declared country/city', () => {
    it('ranks a worker in the employer\u2019s own city first', async () => {
      deps.prisma.profile.findUnique.mockResolvedValue({
        latitude: null,
        longitude: null,
        country_code: 'CG',
        city: 'Brazzaville',
      });
      deps.sources.workersFromAffinities.mockResolvedValue([
        worker('elsewhere', { countryCode: 'CG', city: 'Dolisie' }),
        worker('local', { countryCode: 'CG', city: 'Brazzaville' }),
      ]);

      expect((await recommend(2))[0].id).toBe('local');
    });
  });
});
