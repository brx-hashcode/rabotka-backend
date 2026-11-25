/**
 * The score of a candidate against an offer's grid, and why one is ahead of
 * another. Pure: no model, no database. The model only says what a CV shows;
 * every number is made here, the same way for every candidate.
 */

/** 0 leaves the criterion out; 1 useful, 2 important, 3 essential. */
export type Importance = 0 | 1 | 2 | 3;

/** One thing a criterion asks for: a skill, a tool, a certificate. */
export type Asked = { label: string; importance: Importance };

export type FitItem = {
  key: string;
  importance: Importance;
  /** When listed, the mark is how much of it the CV shows (`coverage`). */
  asked?: Asked[];
};

/** A candidate's mark per criterion, 0–100; absent or null: the CV does not show it. */
export type Marks = Record<string, number | null | undefined>;

export type MustStatus = 'MET' | 'MISSING' | 'UNCLEAR';

/** Months after which experience, when the offer asks for no duration, reaches 63. */
const SATURATION_MONTHS = 24;
/** The geometric mean's floor: one zero must not erase a candidate. */
const GEOMETRIC_FLOOR = 5;

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/** An unreadable or absent mark counts 0, so everyone is divided by the same total. */
function markOf(marks: Marks, key: string): number {
  const v = marks[key];
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v) : 0;
}

const counted = <T extends { importance: Importance }>(items: T[]) =>
  items.filter((i) => i.importance > 0);

const total = (items: { importance: Importance }[]) =>
  items.reduce((sum, i) => sum + i.importance, 0);

/**
 * How much of what is asked the CV shows, 0–100, by importance. Anything more
 * the candidate knows costs nothing. Null when nothing is asked.
 */
export function coverage(
  asked: Asked[],
  found: ReadonlySet<string>,
): number | null {
  const list = counted(asked);
  const all = total(list);
  if (all === 0) return null;
  return Math.round(
    (total(list.filter((a) => found.has(a.label))) / all) * 100,
  );
}

/** What work only partly related to the post can bring at most. */
const PARTIAL_MAX = 50;

/**
 * Experience out of 100: against the duration asked (more adds nothing), or by
 * saturation when none is. Work only partly related helps up to half: years
 * in a shop are not years of accounting. Null when the CV gives no dates.
 */
export function experienceMark(
  months: { relevant: number | null; direct: number | null },
  askedMonths: number | null = null,
): number | null {
  if (months.relevant === null || !Number.isFinite(months.relevant))
    return null;
  const mark = (n: number) =>
    clamp(
      (askedMonths && askedMonths > 0
        ? n / askedMonths
        : 1 - Math.exp(-n / SATURATION_MONTHS)) * 100,
    );
  const direct = mark(Math.max(0, months.direct ?? 0));
  const all = mark(Math.max(0, months.relevant));
  return Math.round(Math.max(direct, Math.min(all, PARTIAL_MAX)));
}

/** The score before rounding: the weighted mean over every criterion of the grid. */
export function exactScore(items: FitItem[], marks: Marks): number {
  const list = counted(items);
  const weights = total(list);
  if (weights === 0) return 0;
  return (
    list.reduce((sum, i) => sum + i.importance * markOf(marks, i.key), 0) /
    weights
  );
}

export function gridScore(items: FitItem[], marks: Marks): number {
  return Math.round(exactScore(items, marks));
}

/**
 * The weighted geometric mean, which a weak criterion pulls down. Measured
 * beside the score by `scripts/cv-eval.ts`; never shown or stored.
 */
export function geometricScore(items: FitItem[], marks: Marks): number {
  const list = counted(items);
  const weights = total(list);
  if (weights === 0) return 0;
  const log = list.reduce(
    (sum, i) =>
      sum +
      i.importance * Math.log(Math.max(GEOMETRIC_FLOOR, markOf(marks, i.key))),
    0,
  );
  return Math.round(Math.exp(log / weights));
}

export type Points = {
  key: string;
  /** Null: the CV does not show it (counted 0). */
  mark: number | null;
  /** What it brings to the score, before rounding. */
  exact: number;
  /** As shown: whole points that add up to the score shown. */
  shown: number;
  /** The most it could bring. */
  max: number;
};

/** « Pourquoi ce score »: the points of each criterion, adding up to the score. */
export function points(items: FitItem[], marks: Marks): Points[] {
  const list = counted(items);
  const weights = total(list);
  if (weights === 0) return [];
  const rows = list.map((i) => {
    const exact = (i.importance * markOf(marks, i.key)) / weights;
    const raw = marks[i.key];
    return {
      key: i.key,
      mark: typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw) : null,
      exact,
      shown: Math.floor(exact),
      max: (i.importance * 100) / weights,
    };
  });
  // Largest remainder: rounding each on its own could miss the score by a few.
  let left =
    gridScore(items, marks) - rows.reduce((sum, r) => sum + r.shown, 0);
  const byRemainder = [...rows].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)),
  );
  for (const row of byRemainder) {
    if (left <= 0) break;
    row.shown++;
    left--;
  }
  return rows;
}

export type Gap = {
  /** A's score minus B's, before rounding. */
  gap: number;
  /** What each criterion adds to it, the largest first. */
  rows: { key: string; a: number | null; b: number | null; diff: number }[];
};

/** « Pourquoi A est devant B »: the gap, criterion by criterion, exactly. */
export function explainGap(items: FitItem[], a: Marks, b: Marks): Gap {
  const pa = points(items, a);
  const pb = points(items, b);
  const rows = pa
    .map((row, i) => ({
      key: row.key,
      a: row.mark,
      b: pb[i].mark,
      diff: row.exact - pb[i].exact,
    }))
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  return { gap: exactScore(items, a) - exactScore(items, b), rows };
}

/** « À vérifier » is not missing: only what is known to be absent counts. */
export function missingMusts(musts: Record<string, MustStatus>): number {
  return Object.values(musts).filter((s) => s === 'MISSING').length;
}

export type Ranked = {
  knockedOut: boolean;
  missing: number;
  score: number | null;
  createdAt: Date;
};

/**
 * The order of an offer's candidates: « éliminatoire » last, then the fewest
 * missing must-haves, the best score, and the newest.
 */
export function compareRank(a: Ranked, b: Ranked): number {
  if (a.knockedOut !== b.knockedOut) return a.knockedOut ? 1 : -1;
  return (
    a.missing - b.missing ||
    (b.score ?? -1) - (a.score ?? -1) ||
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}
