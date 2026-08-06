/**
 * Pure scoring primitives for the recommendation engine.
 *
 * No I/O, no Prisma, no Qdrant — everything here is a total function of its
 * arguments so the ranking maths can be tested exhaustively. The previous ranker
 * had no numeric tests at all, which is how a miscalibration that made three
 * code paths permanently return nothing survived for so long.
 *
 * Invariant enforced throughout: every term is on [0,1], and the combined score
 * is a weighted MEAN (divided by ΣW), never a weighted sum. That means a
 * threshold has the same meaning regardless of how the weights are tuned, and
 * adding a term can't silently inflate every score.
 */

/**
 * The signals that contribute to a candidate's relevance. All on [0,1].
 *
 * `null` means NO EVIDENCE, and is not the same as `0`. A null term is dropped
 * from the mean entirely and its weight redistributes over the terms that do
 * carry information — whereas `0` asserts "measured, and it's bad". Getting this
 * wrong is how the previous ranker ended up with constant terms that moved every
 * score by the same amount and therefore ranked nothing, while still dragging
 * absolute scores below a configured threshold.
 */
export type ScoreTerms = {
  /** Calibrated cosine against the user's interest vector. */
  sim: number | null;
  /** How much this user engages with this category. */
  catAff: number;
  /** How much this user engages with this employer/worker specifically. */
  partyAff: number;
  /** Agreement across independent candidate sources. */
  cf: number | null;
  /**
   * Distance, decayed by the user's own learned tolerance.
   *
   * Null for a REMOTE job, where distance carries no information at all — not
   * "neutral", genuinely absent. A constant 0.5 would drag every remote offer
   * toward the middle against local work while ordering nothing; null drops the
   * term and redistributes its weight onto the signals that do say something.
   */
  prox: number | null;
  /** How soon the job starts. Null for a worker, who has no start time. */
  urgency: number | null;
  /** How recently the item was posted, or the counterparty last active. */
  fresh: number | null;
  /** Counterparty quality prior (fill rate, responsiveness, reliability). */
  quality: number;
  /** Fit against learned amount-band and payment-flow preferences. */
  payFit: number | null;
};

export type ScoreWeights = Record<keyof ScoreTerms, number>;

/**
 * Weight profiles by user maturity.
 *
 * Cold users have no interaction history, so `sim`/`partyAff`/`cf` carry no
 * information and their weight goes to signals that work from attributes alone —
 * mostly proximity and freshness. As history accumulates, weight shifts to the
 * personalized terms. This is what makes two identical profiles diverge: same
 * attributes, different `sim`/`catAff`/`partyAff`/`cf`.
 */
export const COLD_WEIGHTS: ScoreWeights = {
  sim: 0.0,
  catAff: 0.15,
  partyAff: 0.0,
  cf: 0.0,
  prox: 0.35,
  urgency: 0.18,
  fresh: 0.17,
  quality: 0.1,
  payFit: 0.05,
};

export const WARM_WEIGHTS: ScoreWeights = {
  sim: 0.3,
  catAff: 0.15,
  partyAff: 0.06,
  cf: 0.05,
  prox: 0.16,
  urgency: 0.09,
  fresh: 0.08,
  quality: 0.06,
  payFit: 0.05,
};

export const HOT_WEIGHTS: ScoreWeights = {
  sim: 0.36,
  catAff: 0.15,
  partyAff: 0.1,
  cf: 0.08,
  prox: 0.11,
  urgency: 0.06,
  fresh: 0.05,
  quality: 0.05,
  payFit: 0.04,
};

/** Positive-signal counts at which a user is considered warm / fully hot. */
export const WARM_AT = 10;
export const HOT_AT = 40;

export type Penalties = {
  /** Multiplier strength for a category the user keeps rejecting. */
  negCategory: number;
  /** Multiplier strength for something just shown to them. */
  seen: number;
  /** Multiplier strength for something they bookmarked then removed. */
  unsaved: number;
};

export const DEFAULT_PENALTIES: Penalties = {
  negCategory: 0.6,
  seen: 0.7,
  unsaved: 0.4,
};

/**
 * Floor of the realistic calibrated-similarity band, in `calibrateCosine` units.
 *
 * `calibrateCosine` maps the THEORETICAL cosine range [-1,1] onto [0,1]. Real
 * normalized text embeddings never come close to -1: measured against this
 * corpus, an employer scored against 15 workers produced 0.8026–0.8679. A
 * 0.065 spread carrying a 0.30–0.36 weight adds ~0.25 to every candidate and
 * separates them by ~0.02 — a term that moves every score by the same amount
 * and therefore ranks nothing, which is precisely the miscalibration this
 * ranker was rewritten to remove.
 *
 * Re-measure before changing: `spreadSimilarity` is only honest while the floor
 * sits just below what the corpus actually produces.
 */
export const SIMILARITY_FLOOR = 0.75;

/**
 * Stretches a calibrated similarity across [0,1] so it can actually order.
 *
 * A FIXED transform, not a per-request min–max. Normalising within the
 * candidate set would look better distributed but make scores incomparable
 * between requests, breaking the absolute relevance threshold the whole engine
 * depends on. Everything below the floor clamps to 0 — those are candidates
 * with nothing in common, and the distinction between "unrelated" and "very
 * unrelated" is not worth ranking on.
 */
export function spreadSimilarity(calibrated: number): number {
  return clamp01((calibrated - SIMILARITY_FLOOR) / (1 - SIMILARITY_FLOOR));
}

export const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Blends the weight profiles by how much history the user has.
 *
 * Continuous on purpose: the previous implementation stepped between "warm" and
 * "hot" at a fixed signal count, so a user's feed could visibly reshuffle the
 * moment they crossed a threshold. Here the transition is gradual — one more
 * signal never causes a discontinuity.
 */
export function interpolateWeights(positiveCount: number): ScoreWeights {
  const n = Math.max(0, positiveCount);
  const keys = Object.keys(COLD_WEIGHTS) as (keyof ScoreWeights)[];
  const out = {} as ScoreWeights;

  if (n <= WARM_AT) {
    const t = n / WARM_AT;
    for (const k of keys) out[k] = lerp(COLD_WEIGHTS[k], WARM_WEIGHTS[k], t);
    return out;
  }

  const t = Math.min(1, (n - WARM_AT) / (HOT_AT - WARM_AT));
  for (const k of keys) out[k] = lerp(WARM_WEIGHTS[k], HOT_WEIGHTS[k], t);
  return out;
}

/**
 * Weighted mean over the AVAILABLE terms, clamped to [0,1].
 *
 * Terms are clamped individually first, so one out-of-range input can't drag the
 * whole score. Division by the weight of the terms that actually contributed
 * keeps the output calibrated even when a signal is missing: a user with no
 * interest vector is scored on the rest, not penalised for the gap.
 */
export function computeRelevance(
  terms: ScoreTerms,
  weights: ScoreWeights,
): number {
  const keys = Object.keys(weights) as (keyof ScoreTerms)[];
  let totalWeight = 0;
  let sum = 0;
  for (const k of keys) {
    const w = weights[k];
    const value = terms[k];
    if (!Number.isFinite(w) || w <= 0 || value == null) continue;
    totalWeight += w;
    sum += clamp01(value) * w;
  }
  if (totalWeight <= 0) return 0;
  return clamp01(sum / totalWeight);
}

/**
 * Applies suppression multiplicatively.
 *
 * Multiplicative and not additive: an additive penalty is trivially swamped by
 * the other terms, which is why the old ranker could never actually bury
 * anything. Here a fully-penalised candidate really does sink.
 */
export function applyPenalties(
  relevance: number,
  flags: {
    negativeCategory?: boolean;
    /** 1 = just shown, 0 = fully recovered. */
    seenDecay?: number;
    unsaved?: boolean;
  },
  penalties: Penalties = DEFAULT_PENALTIES,
): number {
  let score = clamp01(relevance);
  if (flags.negativeCategory) score *= 1 - clamp01(penalties.negCategory);
  if (flags.seenDecay)
    score *= 1 - clamp01(penalties.seen) * clamp01(flags.seenDecay);
  if (flags.unsaved) score *= 1 - clamp01(penalties.unsaved);
  return clamp01(score);
}

/** Exponential freshness decay. Replaces a linear ramp with a hard floor. */
export function freshnessScore(createdAt: Date, halfLifeHours = 72): number {
  const ageHours = (Date.now() - createdAt.getTime()) / 3_600_000;
  if (ageHours <= 0) return 1;
  if (halfLifeHours <= 0) return 0;
  return clamp01(0.5 ** (ageHours / halfLifeHours));
}

/**
 * How strongly to suppress something the user was just shown.
 *
 * Returns 1 immediately after an impression, decaying linearly to 0 over
 * `recoveryHours`. Suppression by decay rather than by hard exclusion: filtering
 * seen items out entirely starves the feed once a user has browsed a while.
 */
export function seenDecay(lastSeenAt: Date | null, recoveryHours = 72): number {
  if (!lastSeenAt) return 0;
  const ageHours = (Date.now() - lastSeenAt.getTime()) / 3_600_000;
  if (ageHours <= 0) return 1;
  if (recoveryHours <= 0) return 0;
  return clamp01(1 - ageHours / recoveryHours);
}

/**
 * Reciprocal-rank fusion across candidate sources.
 *
 * Sources produce scores on incomparable scales (RRF fusion scores, cosine,
 * literal zeros from SQL), so they are merged by RANK, never by raw score.
 * `k` damps the head so one source can't dominate purely by being listed first.
 */
export function rrfFuse(
  sources: { ids: string[]; weight?: number }[],
  k = 60,
): { id: string; score: number; sources: number }[] {
  const acc = new Map<string, { score: number; sources: number }>();
  for (const src of sources) {
    const weight = src.weight ?? 1;
    if (weight <= 0) continue;
    src.ids.forEach((id, rank) => {
      const prev = acc.get(id) ?? { score: 0, sources: 0 };
      acc.set(id, {
        score: prev.score + weight / (k + rank + 1),
        sources: prev.sources + 1,
      });
    });
  }
  return [...acc.entries()]
    .map(([id, v]) => ({ id, score: v.score, sources: v.sources }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Caps how many items may share a key, across several keys at once.
 *
 * Generalises the old category-only cap. The per-employer cap is the one that
 * matters in practice: a single employer with ten open offers could otherwise
 * fill an entire feed.
 *
 * The caps are a PREFERENCE, not a hard ceiling. A first pass honours them; if
 * that leaves the feed short, the capped-out items are added back in score
 * order. Without the backfill the caps starve the feed in exactly the market
 * this serves — with two active employers and a cap of two, a worker asking for
 * ten recommendations would receive four. Diversity is worth having when supply
 * allows it and never worth an empty screen.
 */
export function diversifyByKeys<T>(
  items: T[],
  caps: { key: (item: T) => string | null; max: number }[],
  targetTotal: number,
): T[] {
  const counters = caps.map(() => new Map<string, number>());
  const out: T[] = [];
  const overflow: T[] = [];

  for (const item of items) {
    if (out.length >= targetTotal) {
      overflow.push(item);
      continue;
    }

    const allowed = caps.every((cap, i) => {
      const k = cap.key(item);
      return k === null || (counters[i].get(k) ?? 0) < cap.max;
    });
    if (!allowed) {
      overflow.push(item);
      continue;
    }

    for (const [i, cap] of caps.entries()) {
      const k = cap.key(item);
      if (k === null) continue;
      counters[i].set(k, (counters[i].get(k) ?? 0) + 1);
    }
    out.push(item);
  }

  // `items` arrives in score order, so the overflow is too — the backfill takes
  // the best of what the caps rejected.
  for (const item of overflow) {
    if (out.length >= targetTotal) break;
    out.push(item);
  }
  return out;
}

/**
 * Rank-based epsilon-greedy selection.
 *
 * With probability 1−ε take the best remaining candidate; otherwise sample from
 * the rest proportional to score. Exploration without reserving fixed slots, so
 * a user with strong preferences still mostly gets what they want while the feed
 * keeps enough variety to learn something new.
 *
 * `rng` is injectable so the behaviour is deterministic under test.
 */
export function epsilonGreedySelect<T extends { score: number }>(
  ranked: T[],
  count: number,
  epsilon: number,
  rng: () => number = Math.random,
): T[] {
  const pool = [...ranked];
  const out: T[] = [];
  const eps = clamp01(epsilon);

  while (pool.length > 0 && out.length < count) {
    const explore = rng() < eps && pool.length > 1;
    if (!explore) {
      out.push(pool.shift()!);
      continue;
    }
    // Sample from the tail, weighted by score.
    const tail = pool.slice(1);
    const total = tail.reduce((s, c) => s + Math.max(0, c.score), 0);
    if (total <= 0) {
      out.push(pool.shift()!);
      continue;
    }
    let target = rng() * total;
    let picked = 0;
    for (const [i, c] of tail.entries()) {
      target -= Math.max(0, c.score);
      if (target <= 0) {
        picked = i + 1;
        break;
      }
    }
    out.push(pool.splice(picked, 1)[0]);
  }
  return out;
}

/**
 * Drops candidates below `minScore` — but never below `keepAtLeast`.
 *
 * A relevance threshold must not be able to empty a feed. That already happened
 * once, silently, on three separate code paths, so the floor is structural.
 */
export function applyThreshold<T extends { score: number }>(
  ranked: T[],
  minScore: number,
  keepAtLeast: number,
): T[] {
  const passing = ranked.filter((r) => r.score >= minScore);
  const floor = Math.min(Math.max(0, keepAtLeast), ranked.length);
  return passing.length >= floor ? passing : ranked.slice(0, floor);
}

/**
 * Normalises a raw affinity count map into [0,1] scores.
 *
 * Divides by the max rather than the sum: the question is "how much does this
 * user like X relative to their favourite", not "what share of their attention
 * did X get" — the latter shrinks every score as a user's interests broaden.
 */
export function normalizeAffinity(
  weights: Map<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  let max = 0;
  for (const v of weights.values()) if (v > max) max = v;
  if (max <= 0) return out;
  for (const [k, v] of weights) {
    if (v > 0) out[k] = clamp01(v / max);
  }
  return out;
}
