import { overallScore } from '../cv-assessment';
import {
  compareRank,
  coverage,
  exactScore,
  experienceMark,
  explainGap,
  geometricScore,
  gridScore,
  missingMusts,
  points,
  type FitItem,
  type Marks,
} from '../scoring';

const items: FitItem[] = [
  { key: 'skills', importance: 3 },
  { key: 'experience', importance: 3 },
  { key: 'tasks', importance: 2 },
  { key: 'training', importance: 1 },
];

describe('scoring', () => {
  it('leaves the previous formula as it is', () => {
    expect(
      overallScore({ skills: 70, location: 100, training: 50, experience: 70 }),
    ).toBe(70);
  });

  it('is the mean of the marks by importance', () => {
    // (3×80 + 3×60 + 2×50 + 1×20) / 9 = 540 / 9
    const marks = { skills: 80, experience: 60, tasks: 50, training: 20 };
    expect(gridScore(items, marks)).toBe(60);
  });

  it('divides everyone by the same total: what a CV does not show counts 0', () => {
    expect(gridScore(items, { skills: 90 })).toBe(30);
    expect(gridScore(items, { skills: 90, experience: null })).toBe(30);
    expect(gridScore(items, {})).toBe(0);
    expect(gridScore([], { skills: 90 })).toBe(0);
  });

  it('leaves out a criterion of no importance, and keeps marks in 0–100', () => {
    const off: FitItem[] = [...items, { key: 'location', importance: 0 }];
    const marks = { skills: 80, experience: 60, tasks: 50, training: 20 };
    expect(gridScore(off, { ...marks, location: 100 })).toBe(60);
    expect(gridScore([{ key: 'skills', importance: 2 }], { skills: 180 })).toBe(
      100,
    );
    expect(
      gridScore([{ key: 'skills', importance: 2 }], { skills: Number.NaN }),
    ).toBe(0);
  });

  it('counts how much of what is asked is found, by importance', () => {
    const asked = [
      { label: 'Excel', importance: 3 as const },
      { label: 'Sage', importance: 1 as const },
      { label: 'Word', importance: 0 as const },
    ];
    expect(coverage(asked, new Set(['Excel']))).toBe(75);
    // More than asked adds nothing and costs nothing.
    expect(coverage(asked, new Set(['Excel', 'Sage', 'Python']))).toBe(100);
    expect(coverage(asked, new Set())).toBe(0);
    expect(coverage([], new Set(['Excel']))).toBeNull();
  });

  it('marks experience against the duration asked, or by saturation', () => {
    const same = (n: number | null) => ({ relevant: n, direct: n });
    expect(experienceMark(same(18), 36)).toBe(50);
    expect(experienceMark(same(90), 36)).toBe(100);
    expect(experienceMark(same(0), 36)).toBe(0);
    expect(experienceMark(same(null), 36)).toBeNull();
    expect(experienceMark(same(0))).toBe(0);
    expect(experienceMark(same(24))).toBe(63);
    expect(experienceMark(same(240))).toBe(100);
  });

  it('never takes work only close to the post for the post', () => {
    // Seven years in a shop, for three years of accounting asked.
    expect(experienceMark({ relevant: 42, direct: 0 }, 36)).toBe(50);
    expect(experienceMark({ relevant: 9, direct: 0 }, 36)).toBe(25);
    expect(experienceMark({ relevant: 400, direct: 0 })).toBe(50);
    // It helps someone who has some, up to half; the rest is the real thing.
    expect(experienceMark({ relevant: 30, direct: 12 }, 36)).toBe(50);
    expect(experienceMark({ relevant: 60, direct: 27 }, 36)).toBe(75);
  });

  it('shows points that add up to the score', () => {
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) % 101;
    for (let n = 0; n < 500; n++) {
      const marks: Marks = {
        skills: next(),
        experience: next(),
        tasks: n % 5 ? next() : null,
        training: next(),
      };
      const rows = points(items, marks);
      expect(rows.reduce((s, r) => s + r.shown, 0)).toBe(
        gridScore(items, marks),
      );
      expect(rows.every((r) => Math.abs(r.shown - r.exact) <= 1)).toBe(true);
    }
    expect(points(items, {}).map((r) => [r.mark, r.shown])).toEqual([
      [null, 0],
      [null, 0],
      [null, 0],
      [null, 0],
    ]);
  });

  it('explains the gap exactly, both ways', () => {
    const a = { skills: 90, experience: 40, tasks: 70, training: 10 };
    const b = { skills: 50, experience: 60, tasks: 70, training: 100 };
    const ab = explainGap(items, a, b);
    const ba = explainGap(items, b, a);
    expect(ab.gap).toBeCloseTo(exactScore(items, a) - exactScore(items, b), 10);
    expect(ab.rows.reduce((s, r) => s + r.diff, 0)).toBeCloseTo(ab.gap, 10);
    expect(ba.gap).toBeCloseTo(-ab.gap, 10);
    expect(ab.rows[0]).toMatchObject({ key: 'skills', a: 90, b: 50 });
    expect(ab.rows.at(-1)).toMatchObject({ key: 'tasks', diff: 0 });
  });

  it('pulls an unbalanced candidate down with the geometric mean only', () => {
    const three: FitItem[] = [
      { key: 'skills', importance: 3 },
      { key: 'experience', importance: 3 },
      { key: 'training', importance: 1 },
    ];
    const c = { skills: 90, experience: 90, training: 0 };
    const d = { skills: 70, experience: 70, training: 70 };
    expect(gridScore(three, c)).toBeGreaterThan(gridScore(three, d));
    expect(geometricScore(three, c)).toBeLessThan(geometricScore(three, d));
    expect(geometricScore(three, d)).toBe(70);
  });

  it('counts only what is known to be missing', () => {
    expect(
      missingMusts({ licence: 'MISSING', diploma: 'UNCLEAR', level: 'MET' }),
    ).toBe(1);
  });

  it('ranks knock-outs last, then missing must-haves, score and date', () => {
    const at = (d: number) => new Date(Date.UTC(2026, 10, d));
    const row = (
      id: string,
      knockedOut: boolean,
      missing: number,
      score: number | null,
      day = 1,
    ) => ({ id, knockedOut, missing, score, createdAt: at(day) });
    const order = [
      row('knocked', true, 0, 99),
      row('missing', false, 1, 95),
      row('unscored', false, 0, null),
      row('old', false, 0, 60, 1),
      row('new', false, 0, 60, 2),
      row('best', false, 0, 80),
    ]
      .sort(compareRank)
      .map((r) => r.id);
    expect(order).toEqual([
      'best',
      'new',
      'old',
      'unscored',
      'missing',
      'knocked',
    ]);
  });
});
