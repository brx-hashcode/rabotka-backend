import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  InteractionKind,
  JobOfferStatus,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import type { UserFeatures } from './user-feature.service';
import { spreadSimilarity } from './scoring';
import { HARD_BLOCK_DAYS } from '../penalty/penalty.utils';

/** Candidate pool multiplier — over-fetch so filtering still yields topN. */
const POOL_FACTOR = 4;
/** Ceiling on how many category/employer affinities feed a SQL query. */
const MAX_AFFINITY_KEYS = 12;
/** Minimum co-occurrence count before a CF edge is trusted at all. */
const MIN_CF_SUPPORT = 2;

export type Candidate = {
  id: string;
  categoryId: string | null;
  employerId: string;
  /** Null for an offer with no closing date; `urgency` becomes null too. */
  scheduledAt: Date | null;
  createdAt: Date;
  amount: number | null;
  paymentFlow: string | null;
  latitude: number | null;
  longitude: number | null;
  /**
   * The offer's own declared country/city, falling back to the employer's for
   * rows created before offers had the columns. Used only when the offer has no
   * coordinates, where a coarse "same city" beats the flat constant it
   * replaces.
   */
  countryCode: string | null;
  city: string | null;
  /** Done from anywhere: distance is meaningless, not merely unknown. */
  isRemote: boolean;
};

export type WorkerCandidate = {
  id: string;
  categoryIds: string[];
  latitude: number | null;
  longitude: number | null;
  countryCode: string | null;
  city: string | null;
  createdAt: Date;
};

/**
 * Eligibility for appearing in an employer's feed.
 *
 * `reliabilityMin` and `exclude` are passed in rather than read here: the fee
 * config and the "already contacted" set both belong to the controller, and
 * duplicating that logic is how the existing tiers would disagree about who is
 * showable.
 */
export type WorkerQueryOptions = {
  reliabilityMin: number;
  exclude: Set<string>;
  /**
   * Whether KYC is required to be a candidate. Defaults to true, which is what
   * a feed wants: an unverified worker cannot be hired, so showing them wastes
   * a slot.
   *
   * The notification path can turn it off, because it inherited a population
   * that was never filtered this way and cutting those recipients is a decision
   * to take deliberately rather than as a side effect of changing ranker.
   */
  requireVerified?: boolean;
};

const WORKER_SELECT = {
  id: true,
  latitude: true,
  longitude: true,
  country_code: true,
  city: true,
  created_at: true,
  categories: { select: { category_id: true } },
} satisfies Prisma.ProfileSelect;

type WorkerRow = Prisma.ProfileGetPayload<{ select: typeof WORKER_SELECT }>;

const toWorkerCandidate = (r: WorkerRow): WorkerCandidate => ({
  id: r.id,
  categoryIds: r.categories.map((c) => c.category_id),
  latitude: r.latitude,
  longitude: r.longitude,
  countryCode: r.country_code,
  city: r.city,
  createdAt: r.created_at,
});

function eligibleWorkerWhere(
  opts: WorkerQueryOptions,
): Prisma.ProfileWhereInput {
  return {
    profile_type: ProfileType.WORKER,
    status: AccountStatus.ACTIVE,
    ...(opts.requireVerified === false
      ? {}
      : { verification_status: VerificationStatus.VERIFIED }),
    deleted_at: null,
    reliability_score: { gte: opts.reliabilityMin },
    ...(opts.exclude.size > 0 ? { id: { notIn: [...opts.exclude] } } : {}),
  };
}

/** Open offers only. Mirrors the status pair used everywhere else. */
const OPEN_OFFER_WHERE: Prisma.JobOfferWhereInput = {
  status: { in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED] },
  deleted_at: null,
};

const CANDIDATE_SELECT = {
  id: true,
  category_id: true,
  employer_id: true,
  scheduled_at: true,
  created_at: true,
  amount: true,
  payment_flow: true,
  latitude: true,
  longitude: true,
  country_code: true,
  city: true,
  is_remote: true,
  employer: { select: { country_code: true, city: true } },
} satisfies Prisma.JobOfferSelect;

type CandidateRow = Prisma.JobOfferGetPayload<{
  select: typeof CANDIDATE_SELECT;
}>;

const toCandidate = (r: CandidateRow): Candidate => ({
  id: r.id,
  categoryId: r.category_id,
  employerId: r.employer_id,
  scheduledAt: r.scheduled_at,
  createdAt: r.created_at,
  amount: r.amount == null ? null : Number(r.amount),
  paymentFlow: r.payment_flow,
  latitude: r.latitude,
  longitude: r.longitude,
  // Offer first, employer second — an offer that names its own site must not
  // be overridden by where the person posting it happens to live.
  countryCode: r.country_code ?? r.employer?.country_code ?? null,
  city: r.city ?? r.employer?.city ?? null,
  isRemote: r.is_remote,
});

/**
 * Generates candidate job offers from several independent sources.
 *
 * Sources deliberately return ORDERED ID LISTS rather than scores: their scores
 * are on incomparable scales (RRF fusion, cosine, literal zeros), so they are
 * merged by rank downstream. Mixing raw scores from different retrieval methods
 * on one scale is exactly the miscalibration this rewrite exists to remove.
 */
@Injectable()
export class CandidateSourceService {
  private readonly logger = new Logger(CandidateSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
  ) {}

  /**
   * Calibrated 0–1 semantic similarity between the asking user and each
   * candidate, keyed by candidate id.
   *
   * This is what makes a worker's portfolio count: their realizations are part
   * of the text `MatchingService.buildWorkerText` embeds, so a plumber whose
   * realizations describe pipework sits closer to a plumbing job in vector
   * space. The v2 ranker had this term hardcoded to null, so none of that
   * reached the score.
   *
   * Uses `searchDenseWithFilter`, NOT `searchHybrid`. The latter returns an RRF
   * fusion score (max ≈0.033) that means nothing on an absolute scale — see the
   * `QdrantHit` docblock. `sim` feeds a weighted mean of terms that all mean the
   * same thing on [0,1], so it must be the calibrated cosine. Putting an RRF
   * score here would recreate exactly the miscalibration the v2 rewrite removed.
   *
   * The asking user's vector is READ from the index rather than re-embedded at
   * query time: it is the same vector indexing produced, portfolio included, and
   * it costs a retrieve instead of an embedding.
   *
   * Returns an EMPTY MAP on any failure, like `employerQuality` and
   * `lastActiveAt`. A missing entry becomes `sim: null`, which
   * `computeRelevance` drops while redistributing its weight — so Qdrant being
   * down degrades the ranking instead of emptying the feed.
   */
  async similarity(
    queryCollection: string,
    queryId: string,
    candidateCollection: string,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (candidateIds.length === 0) return out;

    try {
      const vector = await this.queryVector(queryCollection, queryId);
      // No vector means the asker was never indexed. No evidence, not zero
      // evidence — leaving the map empty is what expresses that.
      if (!vector) return out;

      const hits = await this.qdrant.searchDenseWithFilter(
        candidateCollection,
        vector,
        // `has_id` must be nested under `must` — Qdrant rejects it as a
        // top-level field ("unknown field `has_id`, expected one of `should`,
        // `min_should`, `must`, `must_not`"). It fails as a 400, which
        // `similarity()` catches, so getting this wrong yields an empty map and
        // a permanently dead `sim` term rather than a visible error.
        { must: [{ has_id: candidateIds }] },
        candidateIds.length,
      );
      for (const hit of hits) {
        // Stretched across [0,1]: the raw calibrated band for real text
        // embeddings is roughly [0.80, 0.87], which would make `sim` a near
        // constant carrying a third of the weight. See SIMILARITY_FLOOR.
        out.set(String(hit.id), spreadSimilarity(hit.score));
      }
    } catch (err) {
      this.logger.warn('similarity failed', err);
    }
    return out;
  }

  /** The stored dense vector for a point, or null. Mirrors interest-signal. */
  private async queryVector(
    collection: string,
    id: string,
  ): Promise<number[] | null> {
    const points = await this.qdrant.getClient().retrieve(collection, {
      ids: [id],
      with_vector: ['dense'],
      with_payload: false,
    });
    const raw = points[0] as unknown as
      | { vector?: { dense?: unknown } }
      | undefined;
    const dense = raw?.vector?.dense;
    return Array.isArray(dense) && dense.length > 0
      ? (dense as number[])
      : null;
  }

  /**
   * Pure-SQL personalized candidates — the tier that matters most.
   *
   * Requires no Qdrant and no embeddings, so it still personalizes when
   * `matching.use_embeddings` is false (its default) or the vector store is
   * unavailable. This is what stops two identical profiles getting identical
   * feeds in the degraded case.
   */
  async fromAffinities(
    workerId: string,
    features: UserFeatures,
    limit: number,
  ): Promise<Candidate[]> {
    const categoryIds = topKeys(features.categoryAffinity, MAX_AFFINITY_KEYS);
    const employerIds = topKeys(
      features.counterpartyAffinity,
      MAX_AFFINITY_KEYS,
    );
    if (categoryIds.length === 0 && employerIds.length === 0) return [];

    const or: Prisma.JobOfferWhereInput[] = [];
    if (categoryIds.length > 0) or.push({ category_id: { in: categoryIds } });
    if (employerIds.length > 0) or.push({ employer_id: { in: employerIds } });

    const rows = await this.prisma.jobOffer.findMany({
      where: {
        ...OPEN_OFFER_WHERE,
        OR: or,
        // Never resurface something they already acted on.
        applications: { none: { worker_id: workerId } },
        ...(features.negativeCategoryIds.length > 0
          ? { category_id: { notIn: features.negativeCategoryIds } }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit * POOL_FACTOR,
      select: CANDIDATE_SELECT,
    });
    return rows.map(toCandidate);
  }

  /**
   * Collaborative filtering over CATEGORY × EMPLOYER, not over individual offers.
   *
   * Offer-level co-occurrence is useless here: offers live for days, so counts
   * never accumulate before the item disappears. Categories and employers live
   * for months, so "workers who worked this category also worked that one"
   * actually compounds at realistic traffic.
   *
   * Runs off `Application` directly — no new tracking required.
   */
  async fromCollaborativeFiltering(
    workerId: string,
    features: UserFeatures,
    limit: number,
  ): Promise<Candidate[]> {
    const seedCategories = topKeys(features.categoryAffinity, 5);
    if (seedCategories.length === 0) return [];

    try {
      // Peers: other workers who applied in the same categories.
      const peers = await this.prisma.application.findMany({
        where: {
          worker_id: { not: workerId },
          job_offer: { category_id: { in: seedCategories } },
        },
        select: { worker_id: true },
        distinct: ['worker_id'],
        take: 200,
      });
      const peerIds = peers.map((p) => p.worker_id);
      if (peerIds.length === 0) return [];

      // What else those peers engaged with, excluding what we already know about.
      const coOccurring = await this.prisma.application.groupBy({
        by: ['job_offer_id'],
        where: {
          worker_id: { in: peerIds },
          job_offer: {
            ...OPEN_OFFER_WHERE,
            category_id: {
              notIn: [...seedCategories, ...features.negativeCategoryIds],
            },
          },
        },
        _count: { _all: true },
        orderBy: { _count: { job_offer_id: 'desc' } },
        take: limit * POOL_FACTOR,
      });

      const ids = coOccurring
        .filter((c) => c._count._all >= MIN_CF_SUPPORT)
        .map((c) => c.job_offer_id);
      if (ids.length === 0) return [];

      const rows = await this.prisma.jobOffer.findMany({
        where: {
          id: { in: ids },
          ...OPEN_OFFER_WHERE,
          applications: { none: { worker_id: workerId } },
        },
        select: CANDIDATE_SELECT,
      });

      // Preserve co-occurrence order, which the id-set lookup loses.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return ids
        .map((id) => byId.get(id))
        .filter((r): r is CandidateRow => r !== undefined)
        .map(toCandidate);
    } catch (err) {
      this.logger.warn(`CF candidates failed for ${workerId}`, err);
      return [];
    }
  }

  /**
   * The worker's declared domains, newest first. No behaviour required, so this
   * still works for a brand-new profile that has never interacted.
   */
  async fromDeclaredCategories(
    workerId: string,
    categoryIds: string[],
    limit: number,
  ): Promise<Candidate[]> {
    if (categoryIds.length === 0) return [];
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        ...OPEN_OFFER_WHERE,
        category_id: { in: categoryIds },
        applications: { none: { worker_id: workerId } },
      },
      orderBy: { created_at: 'desc' },
      take: limit * POOL_FACTOR,
      select: CANDIDATE_SELECT,
    });
    return rows.map(toCandidate);
  }

  /** Last resort: any open offer. Guarantees the feed is never empty. */
  async fromAllOpen(workerId: string, limit: number): Promise<Candidate[]> {
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        ...OPEN_OFFER_WHERE,
        applications: { none: { worker_id: workerId } },
      },
      orderBy: { created_at: 'desc' },
      take: limit * POOL_FACTOR,
      select: CANDIDATE_SELECT,
    });
    return rows.map(toCandidate);
  }

  /** Hydrates ids returned by a vector search, dropping anything now closed. */
  async hydrateOpen(ids: string[], workerId: string): Promise<Candidate[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        id: { in: ids },
        ...OPEN_OFFER_WHERE,
        applications: { none: { worker_id: workerId } },
      },
      select: CANDIDATE_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is CandidateRow => r !== undefined)
      .map(toCandidate);
  }

  /**
   * Employer-quality priors for a batch of employers, on [0,1].
   *
   * Answers "is this counterparty worth one of the user's limited slots" — an
   * item-quality signal, not personalization. Computed from data that already
   * exists: an employer who fills offers and rarely cancels is a better bet.
   */
  async employerQuality(employerIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (employerIds.length === 0) return out;

    try {
      const profiles = await this.prisma.profile.findMany({
        where: { id: { in: employerIds } },
        select: { id: true, reliability_score: true, rating_avg: true },
      });
      for (const p of profiles) {
        const reliability = (p.reliability_score ?? 100) / 100;
        // rating_avg is 1–5; absent means "no evidence", i.e. neutral.
        const rating = p.rating_avg != null ? (p.rating_avg - 1) / 4 : 0.5;
        out.set(
          p.id,
          Math.min(1, Math.max(0, 0.6 * reliability + 0.4 * rating)),
        );
      }
    } catch (err) {
      this.logger.warn('employerQuality failed', err);
    }
    return out;
  }

  /** Offers the worker has recently been shown, for seen-suppression. */
  async lastSeenAt(
    actorId: string,
    objectIds: string[],
    kinds: InteractionKind[] = [
      InteractionKind.VIEW,
      InteractionKind.IMPRESSION_BATCH,
    ],
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (objectIds.length === 0) return out;
    try {
      const rows = await this.prisma.interactionEvent.findMany({
        where: {
          actor_id: actorId,
          object_id: { in: objectIds },
          kind: { in: kinds },
        },
        orderBy: { occurred_at: 'desc' },
        select: { object_id: true, occurred_at: true },
        take: 500,
      });
      for (const r of rows) {
        if (r.object_id && !out.has(r.object_id)) {
          out.set(r.object_id, r.occurred_at);
        }
      }
    } catch (err) {
      this.logger.warn('lastSeenAt failed', err);
    }
    return out;
  }

  // ── Employer-facing sources: WORKER candidates ────────────────────────────

  /**
   * Workers in the categories this employer has actually engaged with.
   *
   * The mirror of `fromAffinities`, and equally the tier that keeps the employer
   * feed personalized when embeddings are off.
   */
  async workersFromAffinities(
    features: UserFeatures,
    opts: WorkerQueryOptions,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    const categoryIds = topKeys(features.categoryAffinity, MAX_AFFINITY_KEYS);
    if (categoryIds.length === 0) return [];
    return this.queryWorkers(
      {
        ...eligibleWorkerWhere(opts),
        categories: { some: { category_id: { in: categoryIds } } },
      },
      limit,
    );
  }

  /** Workers in the domains this employer posts offers in. No history needed. */
  async workersFromCategories(
    categoryIds: string[],
    opts: WorkerQueryOptions,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    if (categoryIds.length === 0) return [];
    return this.queryWorkers(
      {
        ...eligibleWorkerWhere(opts),
        categories: { some: { category_id: { in: categoryIds } } },
      },
      limit,
    );
  }

  /** Last resort: any eligible worker, so a brand-new employer sees profiles. */
  async workersFromAll(
    opts: WorkerQueryOptions,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    return this.queryWorkers(eligibleWorkerWhere(opts), limit);
  }

  private async queryWorkers(
    where: Prisma.ProfileWhereInput,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    const rows = await this.prisma.profile.findMany({
      where,
      orderBy: [{ reliability_score: 'desc' }, { rating_avg: 'desc' }],
      take: limit * POOL_FACTOR,
      select: WORKER_SELECT,
    });
    return rows.map(toWorkerCandidate);
  }

  /**
   * Quality prior for a batch of workers, on [0,1]. Same formula as
   * `employerQuality` — the notion of "is this counterparty worth a slot" is
   * symmetric, and having one definition stops the two sides drifting apart.
   */
  async workerQuality(workerIds: string[]): Promise<Map<string, number>> {
    return this.employerQuality(workerIds);
  }

  /**
   * When each worker was last active anywhere on the platform.
   *
   * A worker who has been active this week is far more likely to answer than one
   * dormant for months — and unlike `updated_at`, which an admin edit bumps,
   * this reflects the worker's own behaviour. Absent means "never active", which
   * the caller must treat as no evidence rather than as bad: punishing a fresh
   * signup for having no history is a cold-start death spiral.
   */
  async lastActiveAt(workerIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (workerIds.length === 0) return out;
    try {
      const rows = await this.prisma.interactionEvent.findMany({
        where: { actor_id: { in: workerIds } },
        orderBy: { occurred_at: 'desc' },
        select: { actor_id: true, occurred_at: true },
        take: 1000,
      });
      for (const r of rows) {
        if (!out.has(r.actor_id)) out.set(r.actor_id, r.occurred_at);
      }
    } catch (err) {
      this.logger.warn('lastActiveAt failed', err);
    }
    return out;
  }

  /**
   * When each worker was last *sent* a recommendation.
   *
   * Keyed by actor across every object, which is why `lastSeenAt` cannot serve:
   * that one answers "was this worker shown this offer", and notification
   * fatigue is about how recently they were messaged at all. Feeds the graded
   * `seenDecay` penalty, so the ranker prefers people who have not just been
   * contacted — and the hard cooldown rarely has to fire.
   */
  async lastRecommendedAt(workerIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (workerIds.length === 0) return out;
    try {
      const rows = await this.prisma.interactionEvent.findMany({
        where: {
          actor_id: { in: workerIds },
          kind: InteractionKind.RECOMMENDATION_SERVED,
        },
        orderBy: { occurred_at: 'desc' },
        select: { actor_id: true, occurred_at: true },
        take: 1000,
      });
      for (const r of rows) {
        if (!out.has(r.actor_id)) out.set(r.actor_id, r.occurred_at);
      }
    } catch (err) {
      this.logger.warn('lastRecommendedAt failed', err);
    }
    return out;
  }

  /**
   * Workers with an unpaid penalty past the hard-block window.
   *
   * A post-fusion drop rather than part of `eligibleWorkerWhere`, because the
   * predicate lives on `penalty` rather than `profile`. `JobOfferService.create`
   * already refuses to let a hard-blocked *employer* post; a hard-blocked worker
   * has no business being messaged about new work either.
   */
  async hardBlockedWorkerIds(workerIds: string[]): Promise<Set<string>> {
    if (workerIds.length === 0) return new Set();
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - HARD_BLOCK_DAYS);
    try {
      const rows = await this.prisma.penalty.findMany({
        where: {
          profile_id: { in: workerIds },
          paid_at: null,
          applied_at: { lte: threshold },
        },
        select: { profile_id: true },
        distinct: ['profile_id'],
      });
      return new Set(rows.map((r) => r.profile_id));
    } catch (err) {
      // Failing open here notifies someone who should have been skipped, which
      // is far better than failing closed and notifying nobody at all.
      this.logger.warn('hardBlockedWorkerIds failed', err);
      return new Set();
    }
  }

  /** Offers the worker bookmarked and then removed — a soft negative. */
  async unsavedOfferIds(
    workerId: string,
    offerIds: string[],
  ): Promise<Set<string>> {
    if (offerIds.length === 0) return new Set();
    try {
      const rows = await this.prisma.interactionEvent.findMany({
        where: {
          actor_id: workerId,
          object_id: { in: offerIds },
          kind: 'UNSAVE',
        },
        select: { object_id: true },
      });
      return new Set(
        rows.map((r) => r.object_id).filter((id): id is string => id !== null),
      );
    } catch {
      return new Set();
    }
  }
}

/** The highest-scoring keys of an affinity map, capped. */
function topKeys(affinity: Record<string, number>, max: number): string[] {
  return Object.entries(affinity)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => k);
}
