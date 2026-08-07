import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  haversineKm,
  placeProximityScore,
  proximityScore,
  urgencyScore,
} from '../../common/services/geocoding/geo.utils';
import {
  CandidateSourceService,
  type Candidate,
  type WorkerCandidate,
} from './candidate-sources';
import { InteractionKind } from '@prisma/client';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { UserFeatureService, type UserFeatures } from './user-feature.service';
import {
  DEFAULT_PENALTIES,
  applyPenalties,
  applyThreshold,
  clamp01,
  computeRelevance,
  diversifyByKeys,
  epsilonGreedySelect,
  freshnessScore,
  interpolateWeights,
  rrfFuse,
  seenDecay,
  type ScoreTerms,
} from './scoring';

/** Which generator produced a candidate — logged so tier mix is observable. */
export type CandidateTier = 'affinity' | 'cf' | 'declared' | 'all_open';

export type RankedJob = {
  id: string;
  score: number;
  tier: CandidateTier;
};

export type RankedWorker = RankedJob;

/** Per-source weights for rank fusion. Affinity is the most trusted. */
const SOURCE_WEIGHTS: Record<CandidateTier, number> = {
  affinity: 1.0,
  cf: 0.6,
  declared: 0.5,
  all_open: 0.3,
};

const MAX_PER_CATEGORY = 3;
const MAX_PER_EMPLOYER = 2;
/**
 * Half-life for "how recently was this worker active".
 * A week, rather than the 72h used for job freshness: workers are not perishable
 * the way an offer is, and a worker idle for four days is still a live lead.
 */
const ACTIVITY_HALF_LIFE_HOURS = 168;

/**
 * Everything the ranker knows about where the user asking for recommendations
 * is: exact coordinates when geocoding worked, and the country/city they
 * declared either way. The two are carried together so the proximity term can
 * fall back without a second query.
 */
type WorkerPlace = {
  coords: { lat: number; lng: number } | null;
  countryCode: string | null;
  city: string | null;
};

/** The profile row the two recommend paths select, as a `WorkerPlace`. */
function toPlace(
  row: {
    latitude: number | null;
    longitude: number | null;
    country_code: string | null;
    city: string | null;
  } | null,
): WorkerPlace {
  return {
    coords:
      row?.latitude != null && row.longitude != null
        ? { lat: row.latitude, lng: row.longitude }
        : null,
    countryCode: row?.country_code ?? null,
    city: row?.city ?? null,
  };
}

/**
 * The unified ranker.
 *
 * Replaces three separate, mutually inconsistent ranking implementations. Every
 * term it scores is calibrated to [0,1] and combined as a weighted mean, so the
 * relevance threshold means the same thing regardless of tuning — unlike the
 * previous design, where the semantic term contributed ~2% of the total and the
 * threshold was unreachable.
 *
 * Candidate generation is tiered and each tier stands alone, so the feed
 * degrades rather than empties when embeddings are disabled or Qdrant is down.
 */
@Injectable()
export class RecommendationEngineService {
  private readonly logger = new Logger(RecommendationEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sources: CandidateSourceService,
    private readonly features: UserFeatureService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * Ranked open job offers for a worker.
   *
   * `asOf` is honoured throughout for offline replay: no signal at or after that
   * instant may influence the result.
   */
  async recommendJobsForWorker(
    workerId: string,
    limit = 10,
    opts: { asOf?: Date; rng?: () => number } = {},
  ): Promise<RankedJob[]> {
    const features = await this.features.get(workerId);

    const declaredCategories = await this.workerCategoryIds(workerId);
    const pools = await this.gatherCandidates(
      workerId,
      features,
      declaredCategories,
      limit,
    );
    if (pools.size === 0) return [];

    // Fuse by RANK across sources — their scores are not comparable.
    const fused = rrfFuse(
      [...pools.entries()].map(([tier, candidates]) => ({
        ids: candidates.map((c) => c.id),
        weight: SOURCE_WEIGHTS[tier],
      })),
    );

    const byId = new Map<string, Candidate>();
    const tierOf = new Map<string, CandidateTier>();
    for (const [tier, candidates] of pools) {
      for (const c of candidates) {
        if (!byId.has(c.id)) {
          byId.set(c.id, c);
          tierOf.set(c.id, tier);
        }
      }
    }

    const candidateIds = fused.map((f) => f.id);
    const [worker, quality, lastSeen, unsaved, simScores] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: workerId },
        select: {
          latitude: true,
          longitude: true,
          country_code: true,
          city: true,
        },
      }),
      this.sources.employerQuality([
        ...new Set(candidateIds.map((id) => byId.get(id)?.employerId ?? '')),
      ]),
      this.sources.lastSeenAt(workerId, candidateIds),
      this.sources.unsavedOfferIds(workerId, candidateIds),
      // The worker's own vector carries their portfolio; the jobs' carry their
      // text. Empty when embeddings are off or Qdrant is unreachable, which
      // leaves `sim` null rather than zero.
      this.similarityFor(
        COLLECTIONS.WORKERS,
        workerId,
        COLLECTIONS.JOBS,
        candidateIds,
      ),
    ]);

    const weights = interpolateWeights(features.positiveCount);
    const negativeCategories = new Set(features.negativeCategoryIds);
    const workerPlace = toPlace(worker);

    // `sim` stays null until the vector tier lands. Deriving it from fused rank
    // would be dishonest: within a tier the order is `created_at desc`, so the
    // heaviest-weighted term would silently be recency — duplicating `fresh` and
    // swamping the learned affinities this rewrite exists to surface.
    const scored = fused.map((f) => {
      const c = byId.get(f.id)!;
      const terms: ScoreTerms = {
        sim: simScores.get(c.id) ?? null,
        // `?? null`, never `?? 0`: an unlearned category is no evidence, and
        // zero would spend the full 0.15 weight asserting "measured, and bad"
        // — identical for every candidate, so it orders nothing while dragging
        // the whole feed toward the relevance threshold.
        catAff: c.categoryId
          ? (features.categoryAffinity[c.categoryId] ?? null)
          : null,
        partyAff: features.counterpartyAffinity[c.employerId] ?? null,
        // Agreement across independent sources is itself evidence — but only
        // when there is more than one source to agree.
        cf: pools.size > 1 ? clamp01((f.sources - 1) / (pools.size - 1)) : null,
        prox: this.proximityTerm(workerPlace, c, features),
        // Null, not 0.5. An offer with no closing date carries no urgency
        // evidence at all, and computeRelevance drops a null term and
        // redistributes its weight — whereas a constant would move every score
        // by the same amount, ranking nothing while still spending 0.18.
        urgency: c.scheduledAt === null ? null : urgencyScore(c.scheduledAt),
        fresh: freshnessScore(c.createdAt),
        quality: quality.get(c.employerId) ?? null,
        payFit: this.payFitTerm(c, features),
      };

      const relevance = computeRelevance(terms, weights);
      const score = applyPenalties(
        relevance,
        {
          negativeCategory: c.categoryId
            ? negativeCategories.has(c.categoryId)
            : false,
          seenDecay: seenDecay(lastSeen.get(c.id) ?? null),
          unsaved: unsaved.has(c.id),
        },
        DEFAULT_PENALTIES,
      );

      return { id: c.id, score, tier: tierOf.get(c.id)!, candidate: c };
    });

    scored.sort((a, b) => b.score - a.score);

    const minScore = await this.systemConfig.getRecommendationMinScore();
    const kept = applyThreshold(scored, minScore, limit);

    // Exploration first, building a shortlist twice the size of the feed, then
    // the diversity caps trim it to `limit`. Ordering them the other way lets
    // the explore picks be silently discarded by the caps, which defeats the
    // point of exploring at all.
    const shortlist = epsilonGreedySelect(
      kept,
      limit * 2,
      await this.exploreEpsilon(features.positiveCount),
      opts.rng,
    );

    const selected = diversifyByKeys(
      shortlist,
      [
        { key: (i) => i.candidate.categoryId, max: MAX_PER_CATEGORY },
        // New cap: one employer with many open offers could previously fill an
        // entire feed on its own.
        { key: (i) => i.candidate.employerId, max: MAX_PER_EMPLOYER },
      ],
      limit,
    );

    return selected.map(({ id, score, tier }) => ({ id, score, tier }));
  }

  /**
   * Ranked worker profiles for an employer.
   *
   * The mirror of `recommendJobsForWorker`, sharing the same scoring, penalties,
   * thresholding and exploration. Two terms are genuinely absent on this side —
   * a worker has no start time and no pay amount — so `urgency` and `payFit` are
   * passed as null and their weight redistributes. Passing 0 instead would drag
   * every worker down by the same amount, which changes no ordering but pushes
   * the whole feed under the configured threshold.
   */
  async recommendWorkersForEmployer(
    employerId: string,
    limit = 20,
    opts: {
      exclude?: Set<string>;
      categoryIds?: string[];
      rng?: () => number;
    } = {},
  ): Promise<RankedWorker[]> {
    const exclude = opts.exclude ?? new Set<string>();
    const features = await this.features.get(employerId);

    const fees = await this.systemConfig.getFees();
    const queryOpts = { reliabilityMin: fees.reliabilityScoreMin, exclude };

    const categoryIds =
      opts.categoryIds ?? (await this.employerCategoryIds(employerId));

    const pools = new Map<CandidateTier, WorkerCandidate[]>();
    const add = (tier: CandidateTier, list: WorkerCandidate[]) => {
      if (list.length > 0) pools.set(tier, list);
    };
    const gathered = () =>
      new Set([...pools.values()].flatMap((l) => l.map((c) => c.id))).size;

    add(
      'affinity',
      await this.sources.workersFromAffinities(features, queryOpts, limit),
    );
    if (gathered() < limit) {
      add(
        'declared',
        await this.sources.workersFromCategories(categoryIds, queryOpts, limit),
      );
    }
    if (gathered() < limit) {
      add('all_open', await this.sources.workersFromAll(queryOpts, limit));
    }
    if (pools.size === 0) return [];

    const fused = rrfFuse(
      [...pools.entries()].map(([tier, candidates]) => ({
        ids: candidates.map((c) => c.id),
        weight: SOURCE_WEIGHTS[tier],
      })),
    );

    const byId = new Map<string, WorkerCandidate>();
    const tierOf = new Map<string, CandidateTier>();
    for (const [tier, candidates] of pools) {
      for (const c of candidates) {
        if (!byId.has(c.id)) {
          byId.set(c.id, c);
          tierOf.set(c.id, tier);
        }
      }
    }

    const candidateIds = fused.map((f) => f.id);
    const [employer, quality, lastActive, lastSeen, simScores] =
      await Promise.all([
        this.prisma.profile.findUnique({
          where: { id: employerId },
          select: {
            latitude: true,
            longitude: true,
            country_code: true,
            city: true,
          },
        }),
        this.sources.workerQuality(candidateIds),
        this.sources.lastActiveAt(candidateIds),
        // Which of these workers this employer has already been shown. Without it
        // the employer feed is frozen: the same top profiles resurface on every
        // refresh, and someone who scrolled past them yesterday sees them again.
        this.sources.lastSeenAt(employerId, candidateIds, [
          InteractionKind.PROFILE_VIEW,
          InteractionKind.IMPRESSION_BATCH,
        ]),
        // The direction that answers "does my portfolio help me get found": the
        // candidates ARE workers, so their realizations lift them here.
        this.similarityFor(
          COLLECTIONS.EMPLOYERS,
          employerId,
          COLLECTIONS.WORKERS,
          candidateIds,
        ),
      ]);

    const weights = interpolateWeights(features.positiveCount);
    const negativeCategories = new Set(features.negativeCategoryIds);
    const employerPlace = toPlace(employer);

    const scored = fused.map((f) => {
      const c = byId.get(f.id)!;
      const active = lastActive.get(c.id);
      const terms: ScoreTerms = {
        sim: simScores.get(c.id) ?? null,
        catAff: bestCategoryAffinity(c.categoryIds, features.categoryAffinity),
        partyAff: features.counterpartyAffinity[c.id] ?? null,
        cf: pools.size > 1 ? clamp01((f.sources - 1) / (pools.size - 1)) : null,
        prox: this.workerProximity(employerPlace, c, features),
        // A worker has no scheduled start and no pay amount.
        urgency: null,
        // Recency of the worker's OWN activity, not of their profile row.
        fresh: active ? freshnessScore(active, ACTIVITY_HALF_LIFE_HOURS) : null,
        quality: quality.get(c.id) ?? null,
        payFit: null,
      };

      const relevance = computeRelevance(terms, weights);
      const score = applyPenalties(
        relevance,
        {
          negativeCategory: c.categoryIds.some((id) =>
            negativeCategories.has(id),
          ),
          seenDecay: seenDecay(lastSeen.get(c.id) ?? null),
        },
        DEFAULT_PENALTIES,
      );

      return { id: c.id, score, tier: tierOf.get(c.id)!, candidate: c };
    });

    scored.sort((a, b) => b.score - a.score);

    const minScore = await this.systemConfig.getRecommendationMinScore();
    const kept = applyThreshold(scored, minScore, limit);

    const shortlist = epsilonGreedySelect(
      kept,
      limit * 2,
      await this.exploreEpsilon(features.positiveCount),
      opts.rng,
    );

    // Spread across trades so an employer hiring in two domains isn't shown
    // twenty candidates from one. Scaled to the feed size, since this side asks
    // for far more results than the job feed does.
    const selected = diversifyByKeys(
      shortlist,
      [
        {
          key: (i) => i.candidate.categoryIds[0] ?? null,
          max: Math.max(MAX_PER_CATEGORY, Math.ceil(limit / 3)),
        },
      ],
      limit,
    );

    return selected.map(({ id, score, tier }) => ({ id, score, tier }));
  }

  /** The domains this employer hires in, derived from their own offers. */
  private async employerCategoryIds(employerId: string): Promise<string[]> {
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        employer_id: employerId,
        deleted_at: null,
        category_id: { not: null },
      },
      select: { category_id: true },
      distinct: ['category_id'],
    });
    return rows
      .map((r) => r.category_id)
      .filter((id): id is string => id !== null);
  }

  /** The employer-side mirror of `proximityTerm`; same fallback, same reasons. */
  private workerProximity(
    employerPlace: WorkerPlace,
    candidate: WorkerCandidate,
    features: UserFeatures,
  ): number {
    if (
      !employerPlace.coords ||
      candidate.latitude == null ||
      candidate.longitude == null
    ) {
      return placeProximityScore(employerPlace, candidate);
    }
    const km = haversineKm(employerPlace.coords, {
      lat: candidate.latitude,
      lng: candidate.longitude,
    });
    return proximityScore(km, features.distanceHalfLifeKm);
  }

  /**
   * Candidate pools, in descending order of trust.
   *
   * Each tier is independently sufficient. Later tiers are only consulted when
   * the earlier ones don't yield enough, so a warm user rarely pays for the
   * broad queries while a brand-new one still gets a full feed.
   */
  private async gatherCandidates(
    workerId: string,
    features: UserFeatures,
    declaredCategories: string[],
    limit: number,
  ): Promise<Map<CandidateTier, Candidate[]>> {
    const pools = new Map<CandidateTier, Candidate[]>();
    const add = (tier: CandidateTier, list: Candidate[]) => {
      if (list.length > 0) pools.set(tier, list);
    };

    const [affinity, cf] = await Promise.all([
      this.sources.fromAffinities(workerId, features, limit),
      this.cfEnabled().then((on) =>
        on
          ? this.sources.fromCollaborativeFiltering(workerId, features, limit)
          : [],
      ),
    ]);
    add('affinity', affinity);
    add('cf', cf);

    const gathered = () =>
      new Set([...pools.values()].flatMap((l) => l.map((c) => c.id))).size;

    if (gathered() < limit) {
      add(
        'declared',
        await this.sources.fromDeclaredCategories(
          workerId,
          declaredCategories,
          limit,
        ),
      );
    }
    if (gathered() < limit) {
      add('all_open', await this.sources.fromAllOpen(workerId, limit));
    }
    return pools;
  }

  /**
   * Similarity scores, or an empty map when embeddings are switched off.
   *
   * Gated on the same `matching.use_embeddings` flag the legacy path honours,
   * so one switch still disables embeddings everywhere. Checking it here rather
   * than inside `similarity()` keeps the Qdrant calls from being made at all.
   */
  private async similarityFor(
    queryCollection: string,
    queryId: string,
    candidateCollection: string,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    try {
      if (!(await this.systemConfig.isSimilarityEnabled())) {
        return new Map();
      }
      return await this.sources.similarity(
        queryCollection,
        queryId,
        candidateCollection,
        candidateIds,
      );
    } catch (err) {
      // `similarity()` already swallows Qdrant faults, but the config lookup in
      // front of it does not — and this runs inside a Promise.all, where one
      // rejection would take the whole feed down. A ranking without `sim` is a
      // worse feed; a thrown error is no feed at all.
      this.logger.warn('similarity lookup failed', err);
      return new Map();
    }
  }

  /**
   * Distance term using the worker's OWN learned tolerance rather than a single
   * global half-life, falling back to declared country/city when either side
   * has no coordinates.
   *
   * That fallback is the point. This used to return a flat 0.5 in the missing-
   * coordinate case, and `prox` carries 0.35 of the cold-start weight — the
   * heaviest term there is. Since geocoding is fire-and-forget, a failure is
   * silent and permanent, so for those users a third of the ranking was a
   * constant that ordered nothing. Country and city are coarse, but coarse
   * beats constant.
   */
  private proximityTerm(
    workerPlace: WorkerPlace,
    candidate: Candidate,
    features: UserFeatures,
  ): number | null {
    // A remote job is not "distance unknown", it is "distance irrelevant".
    // Returning null drops the term from the weighted mean entirely rather
    // than scoring every remote offer the same flat value against local work.
    if (candidate.isRemote) return null;
    if (
      !workerPlace.coords ||
      candidate.latitude == null ||
      candidate.longitude == null
    ) {
      return placeProximityScore(workerPlace, candidate);
    }
    const km = haversineKm(workerPlace.coords, {
      lat: candidate.latitude,
      lng: candidate.longitude,
    });
    return proximityScore(km, features.distanceHalfLifeKm);
  }

  /**
   * Fit against learned pay preferences, or NULL when nothing is known.
   *
   * Null rather than 0.5: `deriveFeatures` does not yet populate the amount-band
   * or payment-flow affinities, so this returned a constant 0.5 for every
   * candidate — a dead term that changed no ordering while still consuming ~5%
   * of the weight budget and dragging every score toward the middle. That is the
   * exact defect this ranker was built to remove. Returning null drops it from
   * the weighted mean until the affinities are actually learned.
   */
  private payFitTerm(
    candidate: Candidate,
    features: UserFeatures,
  ): number | null {
    const flowFit = candidate.paymentFlow
      ? features.paymentFlowAffinity[candidate.paymentFlow]
      : undefined;
    const bandFit =
      candidate.amount != null
        ? features.amountBandAffinity[amountBand(candidate.amount)]
        : undefined;
    if (flowFit === undefined && bandFit === undefined) return null;
    return clamp01(((flowFit ?? 0.5) + (bandFit ?? 0.5)) / 2);
  }

  /** Exploration shrinks as a user's preferences become well established. */
  private async exploreEpsilon(positiveCount: number): Promise<number> {
    const base = 0.2;
    const floor = 0.1;
    const maturity = Math.min(1, positiveCount / 40);
    return base - (base - floor) * maturity;
  }

  private async cfEnabled(): Promise<boolean> {
    try {
      return (
        (await this.systemConfig.get('matching.cf_enabled', 'false')) === 'true'
      );
    } catch {
      return false;
    }
  }

  private async workerCategoryIds(workerId: string): Promise<string[]> {
    const rows = await this.prisma.profileCategory.findMany({
      where: { profile_id: workerId },
      select: { category_id: true },
    });
    return rows.map((r) => r.category_id);
  }
}

/** Mirrors the bucketing used when indexing offers. */
function amountBand(amount: number): string {
  if (amount <= 0) return 'inconnu';
  if (amount < 5000) return 'petit budget';
  if (amount <= 20000) return 'budget moyen';
  return 'budget élevé';
}

/**
 * The strongest affinity across a worker's declared categories.
 *
 * Max rather than mean: a plumber who also lists gardening should rank on their
 * plumbing when that's what the employer hires for, not be averaged down by the
 * unrelated trade.
 */
/**
 * The strongest learned affinity among a worker's categories, or null if none
 * of them has been learned — "no evidence", which `computeRelevance` drops and
 * redistributes, rather than a zero that would rank nothing at full weight.
 */
function bestCategoryAffinity(
  categoryIds: string[],
  affinity: Record<string, number>,
): number | null {
  let best: number | null = null;
  for (const id of categoryIds) {
    const v = affinity[id];
    if (v != null && (best == null || v > best)) best = v;
  }
  return best;
}
