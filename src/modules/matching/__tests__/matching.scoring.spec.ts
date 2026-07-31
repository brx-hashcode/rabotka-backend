import {
  rankRelevance,
  weightedMean,
  applyThreshold,
  NEGATIVE_HISTORY_MULTIPLIER,
} from '../matching.service';

/**
 * Numeric assertions for the scoring primitives.
 *
 * The pre-existing matching spec asserts only `Array.isArray(result)` on the
 * re-ranking paths, so the scoring math had no regression net at all — which is
 * how the RRF-vs-threshold miscalibration survived: `hit.score * 0.6` where
 * `hit.score` maxes out around 0.033, compared against a 0.5 threshold, meaning
 * three code paths could never return anything.
 *
 * These tests pin the invariants that bug violated.
 */
describe('scoring primitives', () => {
  describe('rankRelevance', () => {
    it('gives the top hit 1 and the last hit 0', () => {
      expect(rankRelevance(0, 10)).toBe(1);
      expect(rankRelevance(9, 10)).toBe(0);
    });

    it('decreases monotonically with rank', () => {
      const scores = Array.from({ length: 8 }, (_, r) => rankRelevance(r, 8));
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThan(scores[i - 1]);
      }
    });

    it('stays within [0,1] for every position', () => {
      for (let total = 1; total <= 20; total++) {
        for (let rank = 0; rank < total; rank++) {
          const v = rankRelevance(rank, total);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    });

    it('treats a single hit as fully relevant rather than dividing by zero', () => {
      expect(rankRelevance(0, 1)).toBe(1);
      expect(Number.isNaN(rankRelevance(0, 0))).toBe(false);
    });
  });

  describe('weightedMean', () => {
    it('normalizes by ΣW so the result is on [0,1] regardless of weights', () => {
      // Weights that sum to far more than 1 must still not exceed 1.
      expect(
        weightedMean([
          { value: 1, weight: 6 },
          { value: 1, weight: 3 },
          { value: 1, weight: 91 },
        ]),
      ).toBe(1);
    });

    it('returns the plain weighted average', () => {
      // (1*0.6 + 0*0.2 + 1*0.1) / 0.9
      expect(
        weightedMean([
          { value: 1, weight: 0.6 },
          { value: 0, weight: 0.2 },
          { value: 1, weight: 0.1 },
        ]),
      ).toBeCloseTo(0.7 / 0.9, 10);
    });

    it('all-zero terms score 0, all-one terms score 1', () => {
      const terms = [0.6, 0.2, 0.1];
      expect(
        weightedMean(terms.map((weight) => ({ value: 0, weight }))),
      ).toBe(0);
      expect(
        weightedMean(terms.map((weight) => ({ value: 1, weight }))),
      ).toBe(1);
    });

    it('does not divide by zero when no terms apply', () => {
      expect(weightedMean([])).toBe(0);
      expect(weightedMean([{ value: 1, weight: 0 }])).toBe(0);
    });

    it('omitting a term is NOT the same as passing a neutral constant', () => {
      // This is the bug: a constant 0.5 term adds a fixed floor, so a candidate
      // that is bad on every real signal still scores well above zero.
      const withNeutralConstant = weightedMean([
        { value: 0, weight: 0.6 },
        { value: 0.5, weight: 0.2 }, // "neutral" filler
        { value: 0, weight: 0.1 },
      ]);
      const omitted = weightedMean([
        { value: 0, weight: 0.6 },
        { value: 0, weight: 0.1 },
      ]);
      expect(omitted).toBe(0);
      expect(withNeutralConstant).toBeGreaterThan(0.1);
    });
  });

  describe('applyThreshold', () => {
    const ranked = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.2 },
      { id: 'd', score: 0.05 },
    ];

    it('drops candidates below the threshold when enough remain', () => {
      expect(applyThreshold(ranked, 0.4, 2).map((r) => r.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('NEVER returns fewer than keepAtLeast, however high the threshold', () => {
      // The invariant the old code violated: a miscalibrated threshold silently
      // emptied the feed.
      for (const min of [0.5, 0.95, 1, 5, Number.POSITIVE_INFINITY]) {
        expect(applyThreshold(ranked, min, 3)).toHaveLength(3);
      }
    });

    it('keeps the highest-scoring candidates when it has to fall back', () => {
      expect(applyThreshold(ranked, 99, 2).map((r) => r.id)).toEqual([
        'a',
        'b',
      ]);
    });

    it('is capped by what is available, not by keepAtLeast', () => {
      expect(applyThreshold(ranked, 99, 10)).toHaveLength(4);
      expect(applyThreshold([], 0.1, 5)).toHaveLength(0);
    });

    it('passes everything through when the threshold is 0', () => {
      expect(applyThreshold(ranked, 0, 1)).toHaveLength(4);
    });
  });

  describe('negative history', () => {
    it('suppresses multiplicatively, below any positive candidate', () => {
      const good = weightedMean([{ value: 0.5, weight: 1 }]);
      const penalised = good * NEGATIVE_HISTORY_MULTIPLIER;
      expect(penalised).toBeLessThan(good);
      // A perfect-scoring rejected candidate must rank below a mediocre fresh one.
      expect(1 * NEGATIVE_HISTORY_MULTIPLIER).toBeLessThan(0.4);
    });
  });
});
