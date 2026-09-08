import {
  SIMILARITY_FLOOR,
  spreadSimilarity,
  COLD_WEIGHTS,
  WARM_WEIGHTS,
  HOT_WEIGHTS,
  WARM_AT,
  HOT_AT,
  DEFAULT_PENALTIES,
  type ScoreTerms,
  interpolateWeights,
  computeRelevance,
  applyPenalties,
  freshnessScore,
  seenDecay,
  rrfFuse,
  diversifyByKeys,
  epsilonGreedySelect,
  applyThreshold,
  normalizeAffinity,
  clamp01,
} from '../scoring';

const ZERO_TERMS: ScoreTerms = {
  sim: 0,
  catAff: 0,
  partyAff: 0,
  cf: 0,
  prox: 0,
  urgency: 0,
  fresh: 0,
  quality: 0,
  payFit: 0,
};
const ONE_TERMS: ScoreTerms = {
  sim: 1,
  catAff: 1,
  partyAff: 1,
  cf: 1,
  prox: 1,
  urgency: 1,
  fresh: 1,
  quality: 1,
  payFit: 1,
};
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

describe('scoring', () => {
  describe('weight profiles', () => {
    it('each profile sums to 1', () => {
      for (const w of [COLD_WEIGHTS, WARM_WEIGHTS, HOT_WEIGHTS]) {
        const sum = Object.values(w).reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 6);
      }
    });

    it('gives a cold user no weight on history-derived terms', () => {
      // With no history these carry zero information; weighting them would be
      // scoring noise.
      expect(COLD_WEIGHTS.sim).toBe(0);
      expect(COLD_WEIGHTS.partyAff).toBe(0);
      expect(COLD_WEIGHTS.cf).toBe(0);
    });

    it('shifts weight toward personalization as history grows', () => {
      expect(HOT_WEIGHTS.sim).toBeGreaterThan(WARM_WEIGHTS.sim);
      expect(WARM_WEIGHTS.sim).toBeGreaterThan(COLD_WEIGHTS.sim);
      // ...and away from generic attribute signals.
      expect(HOT_WEIGHTS.prox).toBeLessThan(COLD_WEIGHTS.prox);
      expect(HOT_WEIGHTS.fresh).toBeLessThan(COLD_WEIGHTS.fresh);
    });
  });

  describe('interpolateWeights', () => {
    it('returns exactly the cold profile at 0 signals', () => {
      expect(interpolateWeights(0)).toEqual(COLD_WEIGHTS);
    });

    it('returns exactly the warm profile at the warm threshold', () => {
      const w = interpolateWeights(WARM_AT);
      for (const k of Object.keys(WARM_WEIGHTS) as (keyof typeof w)[]) {
        expect(w[k]).toBeCloseTo(WARM_WEIGHTS[k], 6);
      }
    });

    it('returns exactly the hot profile at and beyond the hot threshold', () => {
      for (const n of [HOT_AT, HOT_AT + 1, 10_000]) {
        const w = interpolateWeights(n);
        for (const k of Object.keys(HOT_WEIGHTS) as (keyof typeof w)[]) {
          expect(w[k]).toBeCloseTo(HOT_WEIGHTS[k], 6);
        }
      }
    });

    it('is continuous — one more signal never causes a jump', () => {
      // The old implementation stepped at a fixed count, so a user's feed could
      // visibly reshuffle from a single interaction.
      for (let n = 0; n < 60; n++) {
        const a = interpolateWeights(n);
        const b = interpolateWeights(n + 1);
        for (const k of Object.keys(a) as (keyof typeof a)[]) {
          expect(Math.abs(a[k] - b[k])).toBeLessThan(0.05);
        }
      }
    });

    it('always sums to 1 at every maturity', () => {
      for (let n = 0; n <= 60; n++) {
        const sum = Object.values(interpolateWeights(n)).reduce(
          (a, b) => a + b,
          0,
        );
        expect(sum).toBeCloseTo(1, 6);
      }
    });

    it('treats a negative count as cold rather than extrapolating', () => {
      expect(interpolateWeights(-5)).toEqual(COLD_WEIGHTS);
    });
  });

  describe('computeRelevance — null is not zero', () => {
    /**
     * The distinction the whole scoring design rests on, and the one three
     * terms used to get wrong by populating with `?? 0` / `?? 0.5`.
     *
     * A cold worker looking at a job 10 km out (prox 0.25), starting in 48 h
     * (urgency 0.5), posted 24 h ago (fresh 0.794), unrated employer.
     */
    const coldCase = (catAff: number | null): ScoreTerms => ({
      ...ZERO_TERMS,
      sim: null,
      catAff,
      partyAff: null,
      cf: null,
      prox: 0.25,
      urgency: 0.5,
      fresh: 0.794,
      quality: 0.8,
      payFit: null,
    });

    it('drops a null term and redistributes its weight', () => {
      const withZero = computeRelevance(coldCase(0), COLD_WEIGHTS);
      const withNull = computeRelevance(coldCase(null), COLD_WEIGHTS);

      // Same evidence, different divisor: 0.95 vs 0.80.
      expect(withZero).toBeCloseTo(0.413, 3);
      expect(withNull).toBeCloseTo(0.491, 3);
      expect(withNull).toBeGreaterThan(withZero);
    });

    it('a zero term orders nothing but still costs score', () => {
      // Two candidates identical except for a term nobody has evidence on.
      // Scoring it 0 lowers both equally — pure loss against the threshold.
      const a = computeRelevance(coldCase(0), COLD_WEIGHTS);
      const b = computeRelevance(coldCase(0), COLD_WEIGHTS);

      expect(a).toBe(b);
      expect(a).toBeLessThan(computeRelevance(coldCase(null), COLD_WEIGHTS));
    });
  });

  describe('computeRelevance', () => {
    it('maps all-zero terms to 0 and all-one terms to 1', () => {
      for (const n of [0, 10, 40]) {
        const w = interpolateWeights(n);
        expect(computeRelevance(ZERO_TERMS, w)).toBe(0);
        expect(computeRelevance(ONE_TERMS, w)).toBeCloseTo(1, 6);
      }
    });

    it('stays within [0,1] for random term/weight combinations', () => {
      for (let i = 0; i < 500; i++) {
        const terms = Object.fromEntries(
          Object.keys(ZERO_TERMS).map((k) => [k, Math.random()]),
        ) as ScoreTerms;
        const score = computeRelevance(terms, interpolateWeights(i % 60));
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    });

    it('normalizes by ΣW, so scaling all weights changes nothing', () => {
      const terms = { ...ZERO_TERMS, sim: 0.8, prox: 0.4 };
      const base = computeRelevance(terms, WARM_WEIGHTS);
      const scaled = Object.fromEntries(
        Object.entries(WARM_WEIGHTS).map(([k, v]) => [k, v * 37]),
      ) as typeof WARM_WEIGHTS;
      expect(computeRelevance(terms, scaled)).toBeCloseTo(base, 6);
    });

    it('clamps an out-of-range term instead of letting it skew the score', () => {
      const terms = { ...ZERO_TERMS, sim: 99 } as ScoreTerms;
      expect(computeRelevance(terms, WARM_WEIGHTS)).toBeLessThanOrEqual(1);
    });

    it('ignores zero-weighted terms entirely', () => {
      // A cold user's `sim` weight is 0, so a perfect vector match must not move
      // their score at all.
      const withSim = computeRelevance({ ...ZERO_TERMS, sim: 1 }, COLD_WEIGHTS);
      expect(withSim).toBe(0);
    });

    it('excludes a null term from the mean instead of scoring it as zero', () => {
      // Missing evidence must not be read as bad evidence. With `sim` absent,
      // the remaining terms are all 1, so the score must still be 1.
      expect(
        computeRelevance({ ...ONE_TERMS, sim: null }, WARM_WEIGHTS),
      ).toBeCloseTo(1, 6);
      // Whereas an explicit zero really does drag the score down.
      expect(
        computeRelevance({ ...ONE_TERMS, sim: 0 }, WARM_WEIGHTS),
      ).toBeLessThan(1);
    });

    it("redistributes a null term's weight proportionally", () => {
      // Dropping `sim` must be identical to never having declared its weight.
      const { sim: _sim, ...rest } = WARM_WEIGHTS;
      const withoutSim = { ...rest, sim: 0 } as typeof WARM_WEIGHTS;
      const terms = { ...ZERO_TERMS, catAff: 0.7, prox: 0.3, quality: 1 };

      expect(
        computeRelevance({ ...terms, sim: null }, WARM_WEIGHTS),
      ).toBeCloseTo(computeRelevance({ ...terms, sim: 0 }, withoutSim), 6);
    });

    it('returns 0 rather than NaN when every term is null', () => {
      const allNull = Object.fromEntries(
        Object.keys(ZERO_TERMS).map((k) => [k, null]),
      ) as unknown as ScoreTerms;
      expect(computeRelevance(allNull, WARM_WEIGHTS)).toBe(0);
    });

    it('returns 0 rather than NaN when every weight is zero', () => {
      const zeroW = Object.fromEntries(
        Object.keys(COLD_WEIGHTS).map((k) => [k, 0]),
      ) as typeof COLD_WEIGHTS;
      expect(computeRelevance(ONE_TERMS, zeroW)).toBe(0);
    });
  });

  describe('applyPenalties', () => {
    it('leaves an unpenalised score untouched', () => {
      expect(applyPenalties(0.8, {})).toBeCloseTo(0.8, 6);
    });

    it('suppresses multiplicatively for a negative category', () => {
      expect(applyPenalties(1, { negativeCategory: true })).toBeCloseTo(
        1 - DEFAULT_PENALTIES.negCategory,
        6,
      );
    });

    it('scales the seen penalty by how recently it was shown', () => {
      const fresh = applyPenalties(1, { seenDecay: 1 });
      const half = applyPenalties(1, { seenDecay: 0.5 });
      const recovered = applyPenalties(1, { seenDecay: 0 });
      expect(fresh).toBeLessThan(half);
      expect(half).toBeLessThan(recovered);
      expect(recovered).toBe(1);
    });

    it('actually buries a fully-penalised candidate below a mediocre one', () => {
      // The whole point of multiplicative penalties: additive ones get swamped.
      const penalised = applyPenalties(1, {
        negativeCategory: true,
        seenDecay: 1,
        unsaved: true,
      });
      expect(penalised).toBeLessThan(0.15);
      expect(penalised).toBeLessThan(applyPenalties(0.3, {}));
    });

    it('never returns a value outside [0,1]', () => {
      for (const r of [-1, 0, 0.5, 1, 5]) {
        const v = applyPenalties(r, { negativeCategory: true, seenDecay: 1 });
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('freshnessScore', () => {
    it('halves each half-life', () => {
      expect(freshnessScore(hoursAgo(0), 72)).toBeCloseTo(1, 3);
      expect(freshnessScore(hoursAgo(72), 72)).toBeCloseTo(0.5, 2);
      expect(freshnessScore(hoursAgo(144), 72)).toBeCloseTo(0.25, 2);
    });

    it('decreases monotonically and never floors early', () => {
      const series = [0, 12, 48, 120, 500].map((h) =>
        freshnessScore(hoursAgo(h), 72),
      );
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeLessThan(series[i - 1]);
      }
      // The old ramp bottomed out at a hard 0.1 floor after 7 days, so a
      // year-old post scored the same as a week-old one.
      expect(freshnessScore(hoursAgo(24 * 365), 72)).toBeLessThan(0.01);
    });
  });

  describe('seenDecay', () => {
    it('is 0 for something never shown', () => {
      expect(seenDecay(null)).toBe(0);
    });

    it('is 1 immediately after an impression and recovers to 0', () => {
      expect(seenDecay(hoursAgo(0), 72)).toBeCloseTo(1, 2);
      expect(seenDecay(hoursAgo(36), 72)).toBeCloseTo(0.5, 1);
      expect(seenDecay(hoursAgo(72), 72)).toBe(0);
      expect(seenDecay(hoursAgo(500), 72)).toBe(0);
    });
  });

  describe('rrfFuse', () => {
    it('ranks by reciprocal rank, not by raw source score', () => {
      const fused = rrfFuse([{ ids: ['a', 'b', 'c'] }]);
      expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    });

    it('rewards agreement across sources', () => {
      // `b` is mid-ranked everywhere; `a` is first in one list only.
      const fused = rrfFuse([
        { ids: ['a', 'b'] },
        { ids: ['c', 'b'] },
        { ids: ['d', 'b'] },
      ]);
      expect(fused[0].id).toBe('b');
      expect(fused[0].sources).toBe(3);
    });

    it('honours per-source weights', () => {
      const trusted = rrfFuse([
        { ids: ['x'], weight: 10 },
        { ids: ['y'], weight: 1 },
      ]);
      expect(trusted[0].id).toBe('x');
    });

    it('ignores zero- and negative-weight sources', () => {
      const fused = rrfFuse([
        { ids: ['a'], weight: 0 },
        { ids: ['b'], weight: 1 },
      ]);
      expect(fused.map((f) => f.id)).toEqual(['b']);
    });

    it('handles no sources and empty sources', () => {
      expect(rrfFuse([])).toEqual([]);
      expect(rrfFuse([{ ids: [] }])).toEqual([]);
    });
  });

  describe('diversifyByKeys', () => {
    const items = [
      { id: '1', cat: 'a', emp: 'e1' },
      { id: '2', cat: 'a', emp: 'e1' },
      { id: '3', cat: 'a', emp: 'e1' },
      { id: '4', cat: 'a', emp: 'e2' },
      { id: '5', cat: 'b', emp: 'e2' },
    ];

    it('prefers capped items first, in score order', () => {
      const out = diversifyByKeys(items, [{ key: (i) => i.cat, max: 2 }], 3);
      // Two from 'a' (the cap), then the best non-'a' item.
      expect(out.map((i) => i.id)).toEqual(['1', '2', '5']);
    });

    it('spreads across employers before repeating one', () => {
      const out = diversifyByKeys(items, [{ key: (i) => i.emp, max: 1 }], 2);
      expect(out.map((i) => i.id)).toEqual(['1', '4']);
    });

    it('enforces several caps at once while supply allows', () => {
      const out = diversifyByKeys(
        items,
        [
          { key: (i) => i.cat, max: 2 },
          { key: (i) => i.emp, max: 2 },
        ],
        3,
      );
      expect(out.filter((i) => i.cat === 'a').length).toBeLessThanOrEqual(2);
      expect(out.filter((i) => i.emp === 'e1').length).toBeLessThanOrEqual(2);
    });

    it('backfills past the caps rather than returning a short feed', () => {
      // Every item shares one key. A hard cap would return 1 of 5 — on a small
      // marketplace that is an almost-empty screen.
      const sameKey = items.map((i) => ({ ...i, cat: 'a' }));
      const out = diversifyByKeys(sameKey, [{ key: (i) => i.cat, max: 1 }], 5);
      expect(out).toHaveLength(5);
    });

    it('backfills in score order, best rejected item first', () => {
      const sameKey = items.map((i) => ({ ...i, cat: 'a' }));
      const out = diversifyByKeys(sameKey, [{ key: (i) => i.cat, max: 1 }], 3);
      expect(out.map((i) => i.id)).toEqual(['1', '2', '3']);
    });

    it('does not duplicate an item when backfilling', () => {
      const sameKey = items.map((i) => ({ ...i, cat: 'a' }));
      const out = diversifyByKeys(sameKey, [{ key: (i) => i.cat, max: 2 }], 5);
      expect(new Set(out.map((i) => i.id)).size).toBe(out.length);
    });

    it('never returns more than the input, however generous the target', () => {
      expect(
        diversifyByKeys(items, [{ key: (i) => i.cat, max: 1 }], 99),
      ).toHaveLength(items.length);
    });

    it('stops at the target total', () => {
      expect(
        diversifyByKeys(items, [{ key: (i) => i.cat, max: 99 }], 3),
      ).toHaveLength(3);
    });

    it('never caps on a null key', () => {
      const nulls = [
        { id: '1', cat: null },
        { id: '2', cat: null },
      ];
      expect(
        diversifyByKeys(nulls, [{ key: (i) => i.cat, max: 1 }], 10),
      ).toHaveLength(2);
    });
  });

  describe('epsilonGreedySelect', () => {
    const ranked = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.3 },
    ];

    it('is pure exploitation at epsilon 0', () => {
      expect(
        epsilonGreedySelect(ranked, 3, 0, () => 0.99).map((r) => r.id),
      ).toEqual(['a', 'b', 'c']);
    });

    it('explores when the roll falls under epsilon', () => {
      // rng always 0 → always explores, and picks the first tail candidate.
      const out = epsilonGreedySelect(ranked, 1, 1, () => 0);
      expect(out[0].id).not.toBe('a');
    });

    it('returns every item exactly once, whatever the rolls', () => {
      for (const rng of [() => 0, () => 0.5, () => 0.99, Math.random]) {
        const out = epsilonGreedySelect(ranked, 3, 0.5, rng);
        expect(new Set(out.map((r) => r.id)).size).toBe(out.length);
        expect(out).toHaveLength(3);
      }
    });

    it('never returns more than asked, or more than exist', () => {
      expect(epsilonGreedySelect(ranked, 2, 0.3)).toHaveLength(2);
      expect(epsilonGreedySelect(ranked, 99, 0.3)).toHaveLength(3);
      expect(epsilonGreedySelect([], 5, 0.3)).toHaveLength(0);
    });

    it('falls back to exploitation when the tail has no positive score', () => {
      const flat = [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0 },
      ];
      expect(epsilonGreedySelect(flat, 1, 1, () => 0)[0].id).toBe('a');
    });
  });

  describe('applyThreshold', () => {
    const ranked = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.1 },
    ];

    it('filters when enough candidates survive', () => {
      expect(applyThreshold(ranked, 0.4, 2).map((r) => r.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('NEVER empties the feed, however absurd the threshold', () => {
      for (const min of [1, 5, Number.POSITIVE_INFINITY]) {
        expect(applyThreshold(ranked, min, 2)).toHaveLength(2);
      }
    });

    it('is bounded by what exists', () => {
      expect(applyThreshold(ranked, 9, 99)).toHaveLength(3);
      expect(applyThreshold([], 0.5, 5)).toHaveLength(0);
    });
  });

  describe('normalizeAffinity', () => {
    it('scales relative to the strongest interest', () => {
      const out = normalizeAffinity(
        new Map([
          ['a', 10],
          ['b', 5],
        ]),
      );
      expect(out.a).toBe(1);
      expect(out.b).toBeCloseTo(0.5, 6);
    });

    it('does not shrink as interests broaden', () => {
      // Dividing by the SUM would halve `a` here; dividing by the max doesn't.
      const narrow = normalizeAffinity(new Map([['a', 10]]));
      const broad = normalizeAffinity(
        new Map([
          ['a', 10],
          ['b', 10],
        ]),
      );
      expect(broad.a).toBe(narrow.a);
    });

    it('drops non-positive entries and handles an empty map', () => {
      expect(
        normalizeAffinity(
          new Map([
            ['a', 0],
            ['b', -3],
          ]),
        ),
      ).toEqual({});
      expect(normalizeAffinity(new Map())).toEqual({});
    });
  });

  describe('clamp01', () => {
    it('bounds values and neutralises non-finite input', () => {
      expect(clamp01(-1)).toBe(0);
      expect(clamp01(2)).toBe(1);
      expect(clamp01(0.5)).toBe(0.5);
      expect(clamp01(Number.NaN)).toBe(0);
      expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });
});

/**
 * Similarity has to be stretched before it can rank.
 *
 * `calibrateCosine` maps the theoretical cosine range onto [0,1], but real text
 * embeddings never approach -1. Measured on this corpus, an employer scored
 * against 15 workers produced 0.8026–0.8679 — a 0.065 spread carrying a
 * 0.30–0.36 weight, which adds the same ~0.25 to everyone and orders nothing.
 */
describe('spreadSimilarity', () => {
  /** The real measurements this floor was chosen from. */
  const OBSERVED = [0.8026, 0.8239, 0.8472, 0.8679];

  it('turns a near-constant band into something that can order', () => {
    const before = Math.max(...OBSERVED) - Math.min(...OBSERVED);
    const after =
      Math.max(...OBSERVED.map(spreadSimilarity)) -
      Math.min(...OBSERVED.map(spreadSimilarity));

    expect(before).toBeLessThan(0.1);
    expect(after).toBeGreaterThan(0.2);
  });

  it('stays on [0,1] so the weighted mean keeps its meaning', () => {
    for (const v of [0, 0.5, SIMILARITY_FLOOR, 0.9, 1, 2, -1, NaN]) {
      const out = spreadSimilarity(v);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it('preserves order — it only rescales', () => {
    const sorted = [...OBSERVED].sort((a, b) => a - b).map(spreadSimilarity);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
    }
  });

  it('clamps everything at or below the floor to 0', () => {
    // "Unrelated" and "very unrelated" are not worth ranking between.
    expect(spreadSimilarity(SIMILARITY_FLOOR)).toBe(0);
    expect(spreadSimilarity(0.5)).toBe(0);
    expect(spreadSimilarity(0)).toBe(0);
  });

  it('is a FIXED transform, not a per-request normalisation', () => {
    // The same input must score the same in every request, or the absolute
    // relevance threshold stops meaning anything.
    expect(spreadSimilarity(0.85)).toBe(spreadSimilarity(0.85));
    expect(spreadSimilarity(1)).toBe(1);
  });
});
