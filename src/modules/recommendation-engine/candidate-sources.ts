import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  ApplicationStatus,
  AssignmentStatus,
  InteractionKind,
  InteractionObject,
  JobOfferStatus,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import type { UserFeatures } from './user-feature.service';
import { qualityPrior, spreadSimilarity } from './scoring';
import { hardBlockCutoff } from '../penalty/penalty.utils';

/** Candidate pool multiplier — over-fetch so filtering still yields topN. */
const POOL_FACTOR = 4;

/**
 * Application statuses that mean an employer said yes.
 *
 * STARTED and END are included because they are downstream of an acceptance —
 * counting only ACCEPTED would make a worker look worse the further their
 * engagements actually progressed.
 */
const ACCEPTED_APPLICATION = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
] as const;

/** Offers that reached someone. */
const DELIVERED_OFFER = [
  JobOfferStatus.FILLED,
  JobOfferStatus.COMPLETED,
] as const;

/**
 * Offers that did not, and that the employer is answerable for.
 *
 * ACTIVE and PARTIALLY_FILLED are excluded: an offer still open has not
 * failed yet, and counting it would penalise an employer for posting today.
 */
const WASTED_OFFER = [
  JobOfferStatus.CANCELLED,
  JobOfferStatus.EXPIRED,
] as const;

/** Per-profile counts behind the quality prior. */
type QualityEvidence = {
  missions: number;
  accepted: number;
  rejected: number;
};

const blankEvidence = (): QualityEvidence => ({
  missions: 0,
  accepted: 0,
  rejected: 0,
});
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
  /**
   * Where the hire happens. Restricts candidates to that country, same city
   * first. Null or absent means no restriction — a remote job, or an asker
   * whose country is unknown.
   */
  near?: RetrievalPlace | null;
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

/**
 * Where the asking side is, as declared. Retrieval uses it to keep the pool
 * local; exact coordinates are left to the proximity score.
 */
export type RetrievalPlace = {
  countryCode: string | null;
  city: string | null;
};

/** A geographic restriction: the country to stay in, the city to try first. */
type GeoFilter<W> = { country: W; city: W | null };

const sameText = (value: string) => ({
  equals: value,
  mode: Prisma.QueryMode.insensitive,
});

/**
 * Offers someone in `place` can take: remote ones, and on-site ones in their
 * country — the offer's own, or its employer's when the offer names none.
 *
 * An offer whose country is unknown on both sides is kept: missing data is
 * not evidence that it is elsewhere, and dropping it would hide offers whose
 * only fault is an incomplete profile.
 *
 * Applied at retrieval, not left to the proximity score: distance weighs a
 * tenth of the score for a seasoned user, and the pool is the N newest offers,
 * so offers abroad were filling the pool and pushing local ones out of it.
 */
function offerGeo(
  place: RetrievalPlace | null | undefined,
): GeoFilter<Prisma.JobOfferWhereInput> | null {
  if (!place?.countryCode) return null;
  const country = place.countryCode;
  return {
    country: {
      OR: [
        { is_remote: true },
        { country_code: country },
        { country_code: null, employer: { country_code: country } },
        { country_code: null, employer: { country_code: null } },
      ],
    },
    city: place.city
      ? {
          OR: [
            { city: sameText(place.city) },
            { city: null, employer: { city: sameText(place.city) } },
          ],
        }
      : null,
  };
}

/** Workers someone in `place` can hire. Unknown country is kept, as above. */
function workerGeo(
  place: RetrievalPlace | null | undefined,
): GeoFilter<Prisma.ProfileWhereInput> | null {
  if (!place?.countryCode) return null;
  return {
    country: {
      OR: [{ country_code: place.countryCode }, { country_code: null }],
    },
    city: place.city ? { city: sameText(place.city) } : null,
  };
}

/**
 * Runs a retrieval query restricted to the country, same city first.
 *
 * The query orders by something unrelated to place (recency, reliability), so
 * a single country-wide query would let a busy distant city crowd out the
 * user's own. Two queries — the city, then the rest of the country — put
 * local results first in the list, and lists are fused by rank downstream.
 */
async function nearFirst<W, R extends { id: string }>(
  geo: GeoFilter<W> | null,
  take: number,
  notIn: (ids: string[]) => W,
  run: (extra: W[], take: number) => Promise<R[]>,
): Promise<R[]> {
  if (!geo) return run([], take);
  if (!geo.city) return run([geo.country], take);
  const near = await run([geo.country, geo.city], take);
  if (near.length >= take) return near;
  const rest = await run(
    [geo.country, notIn(near.map((r) => r.id))],
    take - near.length,
  );
  return [...near, ...rest];
}

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
      { vector?: { dense?: unknown } } | undefined;
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
    place: RetrievalPlace | null = null,
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

    const rows = await this.newestOpenNearFirst(
      {
        ...OPEN_OFFER_WHERE,
        OR: or,
        // Never resurface something they already acted on.
        applications: { none: { worker_id: workerId } },
        ...(features.negativeCategoryIds.length > 0
          ? { category_id: { notIn: features.negativeCategoryIds } }
          : {}),
      },
      place,
      limit * POOL_FACTOR,
    );
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
    place: RetrievalPlace | null = null,
  ): Promise<Candidate[]> {
    const seedCategories = topKeys(features.categoryAffinity, 5);
    const geo = offerGeo(place);
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
            ...(geo ? { AND: [geo.country] } : {}),
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
          ...(geo ? { AND: [geo.country] } : {}),
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
   * The worker's declared domains, their city first, newest first. No
   * behaviour required, so this still works for a brand-new profile that has
   * never interacted.
   */
  async fromDeclaredCategories(
    workerId: string,
    categoryIds: string[],
    limit: number,
    place: RetrievalPlace | null = null,
  ): Promise<Candidate[]> {
    if (categoryIds.length === 0) return [];
    const rows = await this.newestOpenNearFirst(
      {
        ...OPEN_OFFER_WHERE,
        category_id: { in: categoryIds },
        applications: { none: { worker_id: workerId } },
      },
      place,
      limit * POOL_FACTOR,
    );
    return rows.map(toCandidate);
  }

  /**
   * Last resort: any open offer the worker can take, their city first.
   * Guarantees the feed is never empty while there is anything nearby.
   */
  async fromAllOpen(
    workerId: string,
    limit: number,
    place: RetrievalPlace | null = null,
  ): Promise<Candidate[]> {
    const rows = await this.newestOpenNearFirst(
      {
        ...OPEN_OFFER_WHERE,
        applications: { none: { worker_id: workerId } },
      },
      place,
      limit * POOL_FACTOR,
    );
    return rows.map(toCandidate);
  }

  /** Hydrates ids returned by a vector search, dropping anything now closed. */
  async hydrateOpen(
    ids: string[],
    workerId: string,
    place: RetrievalPlace | null = null,
  ): Promise<Candidate[]> {
    if (ids.length === 0) return [];
    const geo = offerGeo(place);
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        id: { in: ids },
        ...OPEN_OFFER_WHERE,
        applications: { none: { worker_id: workerId } },
        ...(geo ? { AND: [geo.country] } : {}),
      },
      select: CANDIDATE_SELECT,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is CandidateRow => r !== undefined)
      .map(toCandidate);
  }

  /** Newest open offers matching `where`, kept to `place` — see `nearFirst`. */
  private newestOpenNearFirst(
    where: Prisma.JobOfferWhereInput,
    place: RetrievalPlace | null,
    take: number,
  ): Promise<CandidateRow[]> {
    return nearFirst(
      offerGeo(place),
      take,
      (ids) => ({ id: { notIn: ids } }),
      (extra, n) =>
        this.prisma.jobOffer.findMany({
          where: extra.length > 0 ? { AND: [where, ...extra] } : where,
          orderBy: { created_at: 'desc' },
          take: n,
          select: CANDIDATE_SELECT,
        }),
    );
  }

  /**
   * Employer-quality priors for a batch of employers, on [0,1].
   *
   * Answers "is this counterparty worth one of the user's limited slots" — an
   * item-quality signal, not personalization. Computed from data that already
   * exists: an employer who fills offers and rarely cancels is a better bet.
   *
   * "Missions" for an employer means offers actually delivered, which is the
   * closest thing on their side to a worker's completed assignment: posting
   * twenty offers proves nothing, filling them does.
   */
  async employerQuality(
    employerIds: string[],
  ): Promise<Map<string, number | null>> {
    return this.qualityFor(
      employerIds,
      (ids) => this.employerEvidence(ids),
      InteractionObject.EMPLOYER_PROFILE,
      'employer',
    );
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
      opts.near,
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
      opts.near,
    );
  }

  /** Last resort: any eligible worker, so a brand-new employer sees profiles. */
  async workersFromAll(
    opts: WorkerQueryOptions,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    return this.queryWorkers(eligibleWorkerWhere(opts), limit, opts.near);
  }

  /** Workers matching `where`, kept to `near` — see `nearFirst`. */
  private async queryWorkers(
    where: Prisma.ProfileWhereInput,
    limit: number,
    near: RetrievalPlace | null | undefined,
  ): Promise<WorkerCandidate[]> {
    const rows = await nearFirst(
      workerGeo(near),
      limit * POOL_FACTOR,
      // `where` may already exclude ids; AND keeps both exclusions.
      (ids) => ({ id: { notIn: ids } }),
      (extra, n) =>
        this.prisma.profile.findMany({
          where: extra.length > 0 ? { AND: [where, ...extra] } : where,
          orderBy: [{ reliability_score: 'desc' }, { rating_avg: 'desc' }],
          take: n,
          select: WORKER_SELECT,
        }),
    );
    return rows.map(toWorkerCandidate);
  }

  /**
   * Quality prior for a batch of workers, on [0,1], or null with no history.
   *
   * Same formula as `employerQuality` — "is this counterparty worth a slot" is
   * symmetric, and one definition stops the two sides drifting apart. Only the
   * mission count differs, because the two sides complete different things:
   * a worker finishes assignments, an employer delivers offers.
   */
  async workerQuality(
    workerIds: string[],
  ): Promise<Map<string, number | null>> {
    return this.qualityFor(
      workerIds,
      (ids) => this.workerEvidence(ids),
      InteractionObject.WORKER_PROFILE,
      'worker',
    );
  }

  /**
   * Shared body of `workerQuality` / `employerQuality`.
   *
   * A null entry means no evidence, and the caller must pass it through as null
   * rather than substituting a number: `computeRelevance` drops a null term and
   * redistributes its weight, while any constant would rank nobody while
   * spending the full weight of the term.
   */
  private async qualityFor(
    profileIds: string[],
    evidence: (ids: string[]) => Promise<Map<string, QualityEvidence>>,
    profileObject: InteractionObject,
    side: 'worker' | 'employer',
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (profileIds.length === 0) return out;

    try {
      const [profiles, outcomes, demand] = await Promise.all([
        this.prisma.profile.findMany({
          where: { id: { in: profileIds } },
          select: {
            id: true,
            reliability_score: true,
            rating_avg: true,
            rating_count: true,
          },
        }),
        evidence(profileIds),
        this.demandCounts(profileIds, profileObject, side),
      ]);
      for (const p of profiles) {
        const e = outcomes.get(p.id);
        const d = demand.get(p.id);
        out.set(
          p.id,
          qualityPrior({
            reliabilityScore: p.reliability_score,
            ratingAvg: p.rating_avg,
            ratingCount: p.rating_count,
            completedMissions: e?.missions ?? 0,
            acceptedOutcomes: e?.accepted ?? 0,
            rejectedOutcomes: e?.rejected ?? 0,
            profileViews: d?.views ?? 0,
            contactUnlocks: d?.unlocks ?? 0,
          }),
        );
      }
    } catch (err) {
      // No evidence beats a wrong number: an outage must leave the other terms
      // to do the ranking, not push every candidate to an invented middle.
      this.logger.warn('quality prior failed', err);
    }
    return out;
  }

  /**
   * What a worker has completed, and how their applications were answered.
   *
   * Missions come from assignments rather than applications because an
   * assignment is the record of work actually done; the application statuses
   * answer a different question — whether employers pick this person at all.
   */
  private async workerEvidence(
    workerIds: string[],
  ): Promise<Map<string, QualityEvidence>> {
    const out = new Map<string, QualityEvidence>();
    if (workerIds.length === 0) return out;

    const [assignments, applications] = await Promise.all([
      this.prisma.assignment.groupBy({
        by: ['worker_id'],
        where: {
          worker_id: { in: workerIds },
          status: AssignmentStatus.COMPLETED,
        },
        _count: { _all: true },
      }),
      this.prisma.application.groupBy({
        by: ['worker_id', 'status'],
        where: {
          worker_id: { in: workerIds },
          // PENDING and VIEWED are left out: an unanswered application says
          // something about the employer's inbox, not about the worker.
          status: { in: [...ACCEPTED_APPLICATION, ApplicationStatus.REJECTED] },
        },
        _count: { _all: true },
      }),
    ]);

    for (const r of assignments) {
      out.set(r.worker_id, { ...blankEvidence(), missions: r._count._all });
    }
    for (const r of applications) {
      const e = out.get(r.worker_id) ?? blankEvidence();
      if (r.status === ApplicationStatus.REJECTED) {
        e.rejected += r._count._all;
      } else {
        e.accepted += r._count._all;
      }
      out.set(r.worker_id, e);
    }
    return out;
  }

  /**
   * What an employer has delivered, and how their offers ended.
   *
   * One grouped query answers both: offers filled or completed are the
   * employer's equivalent of a finished mission AND their positive outcomes,
   * while cancelled and expired offers are the wasted ones. Posting proves
   * nothing; delivering does.
   */
  private async employerEvidence(
    employerIds: string[],
  ): Promise<Map<string, QualityEvidence>> {
    const out = new Map<string, QualityEvidence>();
    if (employerIds.length === 0) return out;

    const rows = await this.prisma.jobOffer.groupBy({
      by: ['employer_id', 'status'],
      where: {
        employer_id: { in: employerIds },
        status: { in: [...DELIVERED_OFFER, ...WASTED_OFFER] },
      },
      _count: { _all: true },
    });

    for (const r of rows) {
      const e = out.get(r.employer_id) ?? blankEvidence();
      if ((DELIVERED_OFFER as readonly JobOfferStatus[]).includes(r.status)) {
        e.missions += r._count._all;
        e.accepted += r._count._all;
      } else {
        e.rejected += r._count._all;
      }
      out.set(r.employer_id, e);
    }
    return out;
  }

  /**
   * Interest received: profile views, and contact unlocks the other side paid
   * for.
   *
   * Two sources because they are not the same claim. A view is cheap and
   * partly an echo of past ranking — it is counted, but `qualityPrior` caps
   * what it can be worth. An unlock cost the other party money.
   */
  private async paidUnlockCounts(
    profileIds: string[],
    side: 'worker' | 'employer',
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    // Two branches rather than one dynamic `by` key: a computed key erases the
    // row type and needs a cast to put it back.
    if (side === 'worker') {
      const rows = await this.prisma.contactUnlockAttempt.groupBy({
        by: ['worker_id'],
        where: { worker_id: { in: profileIds }, employer_paid: true },
        _count: { _all: true },
      });
      for (const r of rows) out.set(r.worker_id, r._count._all);
      return out;
    }
    const rows = await this.prisma.contactUnlockAttempt.groupBy({
      by: ['employer_id'],
      where: { employer_id: { in: profileIds }, worker_paid: true },
      _count: { _all: true },
    });
    for (const r of rows) out.set(r.employer_id, r._count._all);
    return out;
  }

  private async demandCounts(
    profileIds: string[],
    profileObject: InteractionObject,
    side: 'worker' | 'employer',
  ): Promise<Map<string, { views: number; unlocks: number }>> {
    const out = new Map<string, { views: number; unlocks: number }>();
    if (profileIds.length === 0) return out;

    const [views, unlocks] = await Promise.all([
      this.prisma.interactionEvent.groupBy({
        by: ['object_id'],
        where: {
          object_type: profileObject,
          object_id: { in: profileIds },
          kind: {
            in: [InteractionKind.PROFILE_VIEW, InteractionKind.PORTFOLIO_VIEW],
          },
        },
        _count: { _all: true },
      }),
      this.paidUnlockCounts(profileIds, side),
    ]);

    for (const r of views) {
      if (!r.object_id) continue;
      out.set(r.object_id, { views: r._count._all, unlocks: 0 });
    }
    for (const [id, count] of unlocks) {
      const prev = out.get(id) ?? { views: 0, unlocks: 0 };
      out.set(id, { ...prev, unlocks: count });
    }
    return out;
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
  async hardBlockedWorkerIds(
    workerIds: string[],
    hardBlockDays: number,
  ): Promise<Set<string>> {
    if (workerIds.length === 0) return new Set();
    const threshold = hardBlockCutoff(hardBlockDays);
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
