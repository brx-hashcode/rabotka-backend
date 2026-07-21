import { AssignmentStatus } from '@prisma/client';
import {
  rankResumeExperiences,
  referenceDate,
  RankableAssignment,
  RankingContext,
  RESUME_UNRATED_PRIOR,
} from '../resume-ranking';

// A fixed "now" so recency is deterministic across runs.
const NOW = new Date('2026-07-01T00:00:00Z').getTime();
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

type Overrides = {
  id?: string;
  status?: AssignmentStatus;
  completed_at?: Date | null;
  scheduled_at?: Date;
  score?: number; // rating the worker earned; omit for unrated
  category_id?: string | null;
  amount?: number | null;
};

// Each assignment carries its own id so tests can assert ordering by identity.
function makeAssignment(
  o: Overrides = {},
): RankableAssignment & { id: string } {
  return {
    id: o.id ?? 'a',
    status: o.status ?? AssignmentStatus.COMPLETED,
    completed_at: o.completed_at === undefined ? daysAgo(10) : o.completed_at,
    ratings: o.score === undefined ? [] : [{ score: o.score }],
    job_offer: {
      category_id: o.category_id === undefined ? 'cat-1' : o.category_id,
      amount: o.amount === undefined ? 10000 : o.amount,
      scheduled_at: o.scheduled_at ?? daysAgo(10),
    },
  };
}

const baseCtx = (over: Partial<RankingContext> = {}): RankingContext => ({
  targetCategoryIds: new Set(['cat-1']),
  ratingAvg: null,
  now: NOW,
  ...over,
});

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('rankResumeExperiences', () => {
  it('returns an empty array for no assignments', () => {
    expect(rankResumeExperiences([], baseCtx())).toEqual([]);
  });

  it('ranks an on-category mission above an off-category one, all else equal', () => {
    const onCat = makeAssignment({ id: 'on', category_id: 'cat-1' });
    const offCat = makeAssignment({ id: 'off', category_id: 'cat-9' });

    const ranked = rankResumeExperiences([offCat, onCat], baseCtx());

    expect(ids(ranked)).toEqual(['on', 'off']);
  });

  it('ranks a higher-rated mission above a lower-rated one', () => {
    const good = makeAssignment({ id: 'good', score: 5 });
    const bad = makeAssignment({ id: 'bad', score: 2 });

    const ranked = rankResumeExperiences([bad, good], baseCtx());

    expect(ids(ranked)).toEqual(['good', 'bad']);
  });

  it('ranks a higher-paying mission above a lower-paying one', () => {
    const rich = makeAssignment({ id: 'rich', amount: 90000 });
    const poor = makeAssignment({ id: 'poor', amount: 5000 });

    const ranked = rankResumeExperiences([poor, rich], baseCtx());

    expect(ids(ranked)).toEqual(['rich', 'poor']);
  });

  it('keeps an older but excellent mission ahead of a fresh mediocre one (long horizon)', () => {
    // 60-day-old 5★, on-category, well paid vs a 1-day-old unrated off-category.
    const oldStar = makeAssignment({
      id: 'old-star',
      score: 5,
      amount: 90000,
      completed_at: daysAgo(60),
      scheduled_at: daysAgo(60),
      category_id: 'cat-1',
    });
    const freshWeak = makeAssignment({
      id: 'fresh-weak',
      amount: 5000,
      completed_at: daysAgo(1),
      scheduled_at: daysAgo(1),
      category_id: 'cat-9',
    });

    const ranked = rankResumeExperiences([freshWeak, oldStar], baseCtx());

    expect(ids(ranked)[0]).toBe('old-star');
  });

  it('interleaves current and completed missions purely by score', () => {
    const currentStrong = makeAssignment({
      id: 'current-strong',
      status: AssignmentStatus.CONFIRMED,
      completed_at: null,
      scheduled_at: daysAgo(2),
      category_id: 'cat-1',
      amount: 80000,
    });
    const completedWeak = makeAssignment({
      id: 'completed-weak',
      status: AssignmentStatus.COMPLETED,
      completed_at: daysAgo(3),
      category_id: 'cat-9',
      amount: 5000,
      score: 2,
    });

    const ranked = rankResumeExperiences(
      [completedWeak, currentStrong],
      baseCtx(),
    );

    // A strong current job outranks a weak completed one despite having no rating.
    expect(ids(ranked)).toEqual(['current-strong', 'completed-weak']);
  });

  it('caps the list at the requested limit', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      makeAssignment({ id: `a${i}`, amount: 1000 * (i + 1) }),
    );

    const ranked = rankResumeExperiences(many, baseCtx({ limit: 5 }));

    expect(ranked).toHaveLength(5);
  });

  it('uses the profile rating average as the prior for unrated missions', () => {
    // Two unrated on-category missions of equal pay; the only differentiator is
    // that ratingAvg raises both equally — so ordering falls to recency.
    const older = makeAssignment({
      id: 'older',
      completed_at: daysAgo(20),
      scheduled_at: daysAgo(20),
    });
    const newer = makeAssignment({
      id: 'newer',
      completed_at: daysAgo(2),
      scheduled_at: daysAgo(2),
    });

    const ranked = rankResumeExperiences(
      [older, newer],
      baseCtx({ ratingAvg: 4.5 }),
    );

    expect(ids(ranked)).toEqual(['newer', 'older']);
  });

  it('falls back to the neutral prior when a mission is unrated and no profile average exists', () => {
    // With identical everything, a rated 3/5 (=0.6) mission ties the unrated
    // prior (0.6): scores are equal, so the tie-break (newer first) decides.
    const rated = makeAssignment({
      id: 'rated',
      score: 3,
      completed_at: daysAgo(5),
      scheduled_at: daysAgo(5),
    });
    const unrated = makeAssignment({
      id: 'unrated',
      completed_at: daysAgo(5),
      scheduled_at: daysAgo(5),
    });

    expect(RESUME_UNRATED_PRIOR).toBeCloseTo(3 / 5);
    const ranked = rankResumeExperiences([rated, unrated], baseCtx());
    // Equal score → deterministic, and stable regardless of input order.
    expect(ids(ranked).sort()).toEqual(['rated', 'unrated']);
  });

  it('breaks ties by the reference date, newest first', () => {
    const a = makeAssignment({
      id: 'a',
      completed_at: daysAgo(30),
      scheduled_at: daysAgo(30),
    });
    const b = makeAssignment({
      id: 'b',
      completed_at: daysAgo(3),
      scheduled_at: daysAgo(3),
    });
    // Identical scoring inputs except date → b (newer) wins.
    const ranked = rankResumeExperiences([a, b], baseCtx());
    expect(ids(ranked)).toEqual(['b', 'a']);
  });

  it('treats a missing amount as neutral rather than crashing', () => {
    const noAmount = makeAssignment({ id: 'none', amount: null });
    const withAmount = makeAssignment({ id: 'some', amount: 50000 });

    const ranked = rankResumeExperiences([noAmount, withAmount], baseCtx());

    // Higher known pay beats the neutral 0.5 of an unknown amount.
    expect(ids(ranked)).toEqual(['some', 'none']);
  });
});

describe('referenceDate', () => {
  it('uses completed_at when present', () => {
    const a = makeAssignment({
      completed_at: daysAgo(5),
      scheduled_at: daysAgo(50),
    });
    expect(referenceDate(a)).toEqual(daysAgo(5));
  });

  it('falls back to the job scheduled_at for current missions', () => {
    const a = makeAssignment({
      status: AssignmentStatus.CONFIRMED,
      completed_at: null,
      scheduled_at: daysAgo(7),
    });
    expect(referenceDate(a)).toEqual(daysAgo(7));
  });
});
