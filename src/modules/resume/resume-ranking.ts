import { AssignmentStatus } from '@prisma/client';

/**
 * Résumé experience ranking.
 *
 * The CV features a worker's most *representative* missions, not merely the most
 * recent ones. Each eligible assignment gets a blended relevance score in
 * [0, 1] and the top {@link RESUME_EXPERIENCE_LIMIT} are shown.
 *
 * The signal set is deliberately tailored to a CV — category fit, the rating the
 * worker earned, pay level, and a long-horizon recency. It intentionally does
 * *not* reuse the geo-proximity / upcoming-urgency signals of `MatchingService`:
 * those answer "which job should this worker take next", which is unrelated to
 * "which past mission best represents them".
 */

/** Relevance weights (sum to 1). Exported so they can later be sourced from
 * SystemConfig for runtime tuning, mirroring MatchingService. */
export const W_CATEGORY = 0.3;
export const W_RATING = 0.3;
export const W_PAY = 0.2;
export const W_RECENCY = 0.2;

/** A great mission months old should still rank — hence a ~6-month horizon,
 * unlike the 7-day decay used for the live job feed. */
export const RESUME_RECENCY_HORIZON_DAYS = 180;

/** Neutral rating prior for an unrated mission (e.g. a current job, or a
 * completed one nobody rated) when the profile has no rating average either.
 * 0.6 ≈ a 3/5 rating — present but unremarkable. */
export const RESUME_UNRATED_PRIOR = 0.6;

/** How many missions the CV lists (kept low to fit one page). */
export const RESUME_EXPERIENCE_LIMIT = 5;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** The minimal shape the ranker needs from an assignment. Kept structural so
 * the Prisma payload type in resume.service.ts satisfies it without coupling. */
export interface RankableAssignment {
  status: AssignmentStatus;
  completed_at: Date | null;
  /** Final fallback for referenceDate when the offer has no closing date. */
  created_at: Date;
  ratings: { score: number }[];
  job_offer: {
    category_id: string | null;
    amount: unknown; // Prisma.Decimal | number | null
    scheduled_at: Date | null;
  };
}

export interface RankingContext {
  /** The worker's target categories (Profile.categories). */
  targetCategoryIds: Set<string>;
  /** Profile.rating_avg (1–5), used as the prior for unrated missions. */
  ratingAvg: number | null;
  /** Overridable for deterministic tests. Defaults to Date.now(). */
  now?: number;
  /** Overridable list size. Defaults to RESUME_EXPERIENCE_LIMIT. */
  limit?: number;
}

/**
 * The date a mission is anchored to: completion if done, else its closing date
 * (current jobs have no completed_at yet), else when the assignment was
 * created.
 *
 * The third fallback exists because CDI/CDD/STAGE offers carry no closing date
 * — without it a permanent engagement would have no date at all to sort or
 * decay by, and the résumé would order it arbitrarily.
 */
export function referenceDate(a: RankableAssignment): Date {
  return a.completed_at ?? a.job_offer.scheduled_at ?? a.created_at;
}

function toNumberOrNull(amount: unknown): number | null {
  if (amount == null) return null;
  const n = Number(amount);
  return Number.isFinite(n) ? n : null;
}

/** 1 if the mission's category is one the worker targets, else 0. */
function categoryMatch(a: RankableAssignment, ctx: RankingContext): number {
  const cat = a.job_offer.category_id;
  return cat != null && ctx.targetCategoryIds.has(cat) ? 1 : 0;
}

/** The 1–5 rating the worker earned, normalized to [0, 1]; falls back to the
 * profile average, then to a neutral prior, when the mission is unrated. */
function ratingNorm(a: RankableAssignment, ctx: RankingContext): number {
  const raw = a.ratings[0]?.score;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return clamp01(raw / 5);
  }
  if (ctx.ratingAvg != null && Number.isFinite(ctx.ratingAvg)) {
    return clamp01(ctx.ratingAvg / 5);
  }
  return RESUME_UNRATED_PRIOR;
}

/** Long-horizon linear decay, floored at 0.1 so old work never scores zero. */
function recencyFactor(a: RankableAssignment, now: number): number {
  const ageDays = (now - referenceDate(a).getTime()) / MS_PER_DAY;
  if (!Number.isFinite(ageDays)) return 0.1;
  return Math.max(0.1, 1 - Math.max(0, ageDays) / RESUME_RECENCY_HORIZON_DAYS);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Score every assignment and return the top {@link RankingContext.limit}, most
 * relevant first. Pay is min–max normalized across the given set, so a worker's
 * own higher-paying missions rank up; jobs with no amount get a neutral 0.5.
 *
 * Pure and deterministic given `ctx.now`.
 */
export function rankResumeExperiences<T extends RankableAssignment>(
  assignments: T[],
  ctx: RankingContext,
): T[] {
  if (assignments.length === 0) return [];

  const now = ctx.now ?? Date.now();
  const limit = ctx.limit ?? RESUME_EXPERIENCE_LIMIT;

  // Min–max range of pay across this worker's own missions.
  const amounts = assignments
    .map((a) => toNumberOrNull(a.job_offer.amount))
    .filter((n): n is number => n != null && n > 0);
  const minPay = amounts.length ? Math.min(...amounts) : 0;
  const maxPay = amounts.length ? Math.max(...amounts) : 0;
  const paySpan = maxPay - minPay;

  const payNorm = (amount: unknown): number => {
    const n = toNumberOrNull(amount);
    if (n == null || n <= 0) return 0.5; // unknown pay → neutral
    if (paySpan <= 0) return 1; // single value / all equal → top
    return clamp01((n - minPay) / paySpan);
  };

  const scored = assignments.map((a) => ({
    assignment: a,
    ref: referenceDate(a).getTime(),
    score:
      W_CATEGORY * categoryMatch(a, ctx) +
      W_RATING * ratingNorm(a, ctx) +
      W_PAY * payNorm(a.job_offer.amount) +
      W_RECENCY * recencyFactor(a, now),
  }));

  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    return y.ref - x.ref; // stable tie-break: newer first
  });

  return scored.slice(0, limit).map((s) => s.assignment);
}
