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
  /** How much this user engages with this category. Null when unlearned. */
  catAff: number | null;
  /**
   * How much this user engages with this employer/worker specifically.
   *
   * Null when there is no history with them — a first encounter is unknown, not
   * bad. Zero here used to consume the full weight while ordering nothing.
   */
  partyAff: number | null;
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
  /**
   * Counterparty quality prior (fill rate, responsiveness, reliability).
   *
   * Null for an unrated counterparty. A 0.5 "neutral" constant is the same
   * mistake wearing a plausible number: it is identical for everyone it is
   * applied to, so it orders nothing while still spending its weight.
   */
  quality: number | null;
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
 *
 * `quality` carries roughly double what it used to. A proven counterparty —
 * well rated, over missions actually completed — is the strongest predictor
 * available of how the engagement ends, and at 0.05–0.10 it could not outrank
 * an offer posted an hour closer to now. The increase is paid for by `urgency`
 * and `fresh`, which say when something was posted rather than anything about
 * who is on the other side. It is NOT paid for by the personalized terms:
 * matching someone to work they want stays the point.
 */
/**
 * `sim` is weighted from the very first request. It used to be 0 here, on the
 * idea that similarity needs history — but the vectors are built from the
 * profile and the offers themselves, so they exist on day one. At 0 a new
 * employer's feed was ranked on distance, freshness and reliability alone, and
 * the one signal saying whether a worker fits the trade was ignored exactly
 * when there was nothing else to go on. The other terms keep their old
 * proportions, scaled to make room.
 */
export const COLD_WEIGHTS: ScoreWeights = {
  sim: 0.25,
  catAff: 0.1125,
  partyAff: 0.0,
  cf: 0.0,
  prox: 0.2625,
  urgency: 0.105,
  fresh: 0.0975,
  quality: 0.135,
  payFit: 0.0375,
};

export const WARM_WEIGHTS: ScoreWeights = {
  sim: 0.3,
  catAff: 0.15,
  partyAff: 0.06,
  cf: 0.05,
  prox: 0.16,
  urgency: 0.06,
  fresh: 0.05,
  quality: 0.12,
  payFit: 0.05,
};

export const HOT_WEIGHTS: ScoreWeights = {
  sim: 0.36,
  catAff: 0.15,
  partyAff: 0.1,
  cf: 0.08,
  prox: 0.09,
  urgency: 0.05,
  fresh: 0.03,
  quality: 0.1,
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

/**
 * How well a candidate FITS what is asked — the « compatibilité » shown to
 * people — from fit evidence only: the profile/offer similarity on its fixed
 * absolute scale (`spreadSimilarity`) and whether the trades match.
 *
 * Deliberately NOT the ranking score. Ranking also weighs proximity,
 * freshness and reliability, which say "worth showing first", not "suited to
 * the job" — and because `computeRelevance` drops missing terms, a nearby,
 * active, reliable but unrelated worker reached 1.0 there and was displayed as
 * a 100 % match.
 *
 * - With similarity: mostly similarity, the trade match on top. With no
 *   target trade to compare, similarity alone.
 * - Trade evidence only: a match is promising but unproven (0.55, never
 *   "very compatible"); a mismatch is low.
 * - No evidence at all: null — show nothing rather than a number we made up.
 */
export function fitScore(evidence: {
  sim: number | null;
  /** null when the target has no trade to compare against. */
  categoryMatch: boolean | null;
  /**
   * Learned engagement with the candidate's category (0–1), when there is
   * any. Counts as trade evidence alongside the exact match: someone who keeps
   * acting on this trade fits it, declared or not.
   */
  categoryAffinity?: number | null;
}): number | null {
  const { sim, categoryMatch, categoryAffinity } = evidence;
  const affinity =
    categoryAffinity != null && Number.isFinite(categoryAffinity)
      ? clamp01(categoryAffinity)
      : null;
  const category =
    categoryMatch === true
      ? 1
      : affinity !== null
        ? affinity
        : categoryMatch === false
          ? 0
          : null;

  if (sim != null && Number.isFinite(sim)) {
    const s = clamp01(sim);
    if (category === null) return s;
    return clamp01(FIT_SIM_WEIGHT * s + (1 - FIT_SIM_WEIGHT) * category);
  }
  if (category === null) return null;
  return (
    FIT_CATEGORY_ONLY_MISMATCH +
    (FIT_CATEGORY_ONLY_MATCH - FIT_CATEGORY_ONLY_MISMATCH) * category
  );
}

export const FIT_SIM_WEIGHT = 0.75;
export const FIT_CATEGORY_ONLY_MATCH = 0.55;
export const FIT_CATEGORY_ONLY_MISMATCH = 0.15;

/**
 * Folds fit into the ranking score: the usual relevance, scaled by how well
 * the candidate fits. A perfect fit keeps its relevance; an unrelated one
 * keeps about a third, however near, fresh or reliable. Unknown fit is
 * treated as weak, not neutral — no evidence of fit is not a reason to rank
 * someone first.
 */
export function withFit(relevance: number, fit: number | null): number {
  return clamp01(relevance) * fitFactor(fit);
}

/** The multiplier `withFit` applies: FIT_FLOOR (no fit) … 1 (perfect fit). */
export function fitFactor(fit: number | null): number {
  return FIT_FLOOR + (1 - FIT_FLOOR) * clamp01(fit ?? FIT_UNKNOWN);
}

export const FIT_FLOOR = 0.35;
export const FIT_UNKNOWN = 0.2;

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
 * Star rating a counterparty must clear before evidence starts moving them.
 *
 * Ratings on this platform skew high — an employer who was satisfied gives 5,
 * and anything under 4 is a complaint. 3.5 is therefore the middle of the
 * band people actually use, not the middle of the 1–5 scale.
 */
export const RATING_PRIOR_MEAN = 3.5;

/**
 * How many ratings of evidence the prior is worth.
 *
 * A single 5★ is one satisfied employer, not a track record. At 3 the first
 * rating moves the estimate by about a quarter of the distance to the prior,
 * and by the fifth the average is mostly the profile's own.
 */
export const RATING_PRIOR_WEIGHT = 3;

/**
 * Completed missions at which the experience term reaches 0.5.
 *
 * A saturating curve, not a count: the gap between 0 and 3 missions is real
 * evidence, the gap between 40 and 200 is not, and a linear count would make
 * the platform's oldest workers permanently unreachable for everyone else.
 */
export const MISSIONS_HALF_SATURATION = 3;

/**
 * Prior rate, and its weight in decisions, for the accept/fill term.
 *
 * Same shrinkage as the rating, for the same reason: a worker accepted on
 * their only application is not a worker with a 100 % acceptance rate.
 */
export const OUTCOME_PRIOR_RATE = 0.5;
export const OUTCOME_PRIOR_WEIGHT = 3;

/**
 * Weighted interest events at which the demand term reaches 0.5.
 *
 * Unlocks count for more than views because they cost money: an employer who
 * paid to reach this worker has said something a page view has not.
 */
export const DEMAND_HALF_SATURATION = 5;
export const UNLOCK_WEIGHT = 5;

/**
 * How the quality signals trade off against each other.
 *
 * `demand` is deliberately the smallest. Interest received is partly an echo
 * of past ranking — surfacing a profile earns it views, which would then
 * surface it again — so it is capped low and saturates early. The terms that
 * cannot feed back on themselves (what the counterparty said afterwards, what
 * they actually completed) carry the weight.
 */
export const QUALITY_MIX = {
  reliability: 0.28,
  rating: 0.27,
  missions: 0.15,
  outcome: 0.18,
  demand: 0.12,
} as const;

export type QualityInputs = {
  /** Profile.reliability_score, 0–100. */
  reliabilityScore: number | null | undefined;
  /** Profile.rating_avg, 1–5. */
  ratingAvg: number | null | undefined;
  /** Profile.rating_count. */
  ratingCount: number | null | undefined;
  /** Assignments completed (worker) or offers delivered (employer). */
  completedMissions: number | null | undefined;
  /**
   * Decisions that went their way: applications accepted (worker) or offers
   * filled (employer).
   */
  acceptedOutcomes?: number | null;
  /**
   * Decisions that did not: applications rejected (worker) or offers
   * cancelled and expired (employer).
   */
  rejectedOutcomes?: number | null;
  /** Profile views received. Weak on its own — see `demand` above. */
  profileViews?: number | null;
  /** Contact unlocks the other side paid for. The strongest interest signal. */
  contactUnlocks?: number | null;
};

/**
 * Counterparty quality prior on [0,1] — or null when there is nothing to go on.
 *
 * Five signals, because each alone is gameable or blind:
 *  - reliability: platform-administered, says whether they keep commitments;
 *  - rating: how the other side found them afterwards;
 *  - missions: whether either of those numbers rests on anything;
 *  - outcome: whether their applications get accepted / their offers get
 *    filled, which is the market's own verdict and the one signal nobody can
 *    award themselves;
 *  - demand: views and paid contact unlocks received.
 *
 * Returns NULL for a profile with no history of any kind. That is the point of
 * the rewrite: reliability defaults to 100 for everyone, so scoring a
 * brand-new profile on reliability alone produced the same number for all of
 * them — a constant that spent the term's full weight while ordering nothing.
 * `computeRelevance` drops a null instead and redistributes the weight.
 *
 * Every rate is shrunk toward its prior by the volume behind it, so one lucky
 * 5★ ranks below a steady 4.6★ over twenty missions, and one accepted
 * application is not a 100 % acceptance rate. Without that, the fastest route
 * to the top of every list is a single rating from a friend.
 */
export function qualityPrior(inputs: QualityInputs): number | null {
  const ratingCount = Math.max(0, inputs.ratingCount ?? 0);
  const missions = Math.max(0, inputs.completedMissions ?? 0);
  const accepted = Math.max(0, inputs.acceptedOutcomes ?? 0);
  const rejected = Math.max(0, inputs.rejectedOutcomes ?? 0);
  const decided = accepted + rejected;
  const views = Math.max(0, inputs.profileViews ?? 0);
  const unlocks = Math.max(0, inputs.contactUnlocks ?? 0);
  const interest = views + unlocks * UNLOCK_WEIGHT;

  if (ratingCount === 0 && missions === 0 && decided === 0 && interest === 0) {
    return null;
  }

  const terms: { value: number; weight: number }[] = [
    {
      value: clamp01((inputs.reliabilityScore ?? 100) / 100),
      weight: QUALITY_MIX.reliability,
    },
    {
      value: missions / (missions + MISSIONS_HALF_SATURATION),
      weight: QUALITY_MIX.missions,
    },
  ];

  // Only when they have actually been rated: rating_avg is null until then,
  // and feeding the bare prior in would re-introduce the constant this
  // function exists to remove.
  if (ratingCount > 0 && inputs.ratingAvg != null) {
    const shrunk =
      (inputs.ratingAvg * ratingCount +
        RATING_PRIOR_MEAN * RATING_PRIOR_WEIGHT) /
      (ratingCount + RATING_PRIOR_WEIGHT);
    // 1–5 onto [0,1]. Clamped because rating_avg is a stored aggregate: a bad
    // backfill must degrade the term, not poison the whole score.
    terms.push({
      value: clamp01((shrunk - 1) / 4),
      weight: QUALITY_MIX.rating,
    });
  }

  // Pending decisions are excluded on purpose: an application nobody has
  // answered says something about the employer's inbox, not about the worker.
  if (decided > 0) {
    terms.push({
      value: clamp01(
        (accepted + OUTCOME_PRIOR_RATE * OUTCOME_PRIOR_WEIGHT) /
          (decided + OUTCOME_PRIOR_WEIGHT),
      ),
      weight: QUALITY_MIX.outcome,
    });
  }

  if (interest > 0) {
    terms.push({
      value: interest / (interest + DEMAND_HALF_SATURATION),
      weight: QUALITY_MIX.demand,
    });
  }

  const totalWeight = terms.reduce((s, t) => s + t.weight, 0);
  if (totalWeight <= 0) return null;
  return clamp01(
    terms.reduce((s, t) => s + t.value * t.weight, 0) / totalWeight,
  );
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

export const FRESHNESS_HALF_LIFE_HOURS = 72;

/**
 * Exponential freshness decay. Replaces a linear ramp with a hard floor.
 *
 * `now` is a parameter rather than a `Date.now()` read inside: one ranking pass
 * must score every candidate against ONE instant. Read per candidate, a tick
 * landing mid-loop makes a later candidate a millisecond younger than an
 * earlier one — a real score difference, on the order that separates otherwise
 * tied candidates, so the feed's order came to depend on where a millisecond
 * boundary happened to fall. It defaults, so a caller scoring a single item
 * need not care.
 */
export function freshnessScore(
  createdAt: Date,
  halfLifeHours = FRESHNESS_HALF_LIFE_HOURS,
  now: number = Date.now(),
): number {
  const ageHours = (now - createdAt.getTime()) / 3_600_000;
  if (ageHours <= 0) return 1;
  if (halfLifeHours <= 0) return 0;
  return clamp01(0.5 ** (ageHours / halfLifeHours));
}

export const SEEN_RECOVERY_HOURS = 72;

/**
 * How strongly to suppress something the user was just shown.
 *
 * Returns 1 immediately after an impression, decaying linearly to 0 over
 * `recoveryHours`. Suppression by decay rather than by hard exclusion: filtering
 * seen items out entirely starves the feed once a user has browsed a while.
 *
 * `now` is injected for the reason given on `freshnessScore`.
 */
export function seenDecay(
  lastSeenAt: Date | null,
  recoveryHours = SEEN_RECOVERY_HOURS,
  now: number = Date.now(),
): number {
  if (!lastSeenAt) return 0;
  const ageHours = (now - lastSeenAt.getTime()) / 3_600_000;
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
export function applyThreshold<T extends { score: number; gate?: number }>(
  ranked: T[],
  minScore: number,
  keepAtLeast: number,
): T[] {
  // `gate` when present: the relevance before fit was folded in. The
  // thresholds were tuned on that scale, and fit is meant to reorder who is
  // shown, not to empty the list — so who passes is judged as before.
  const passing = ranked.filter((r) => (r.gate ?? r.score) >= minScore);
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
