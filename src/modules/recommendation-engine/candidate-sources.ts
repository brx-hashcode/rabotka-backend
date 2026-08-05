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
import type { UserFeatures } from './user-feature.service';

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
  scheduledAt: Date;
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
    verification_status: VerificationStatus.VERIFIED,
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

  constructor(private readonly prisma: PrismaService) {}

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
