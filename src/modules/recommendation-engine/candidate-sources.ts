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

const POOL_FACTOR = 4;

const ACCEPTED_APPLICATION = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
] as const;

const DELIVERED_OFFER = [
  JobOfferStatus.FILLED,
  JobOfferStatus.COMPLETED,
] as const;

const WASTED_OFFER = [
  JobOfferStatus.CANCELLED,
  JobOfferStatus.EXPIRED,
] as const;

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
const MAX_AFFINITY_KEYS = 12;
const MIN_CF_SUPPORT = 2;

export type Candidate = {
  id: string;
  categoryId: string | null;
  employerId: string;
  scheduledAt: Date | null;
  createdAt: Date;
  amount: number | null;
  paymentFlow: string | null;
  latitude: number | null;
  longitude: number | null;
  countryCode: string | null;
  city: string | null;
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

export type WorkerQueryOptions = {
  reliabilityMin: number;
  exclude: Set<string>;
  requireVerified?: boolean;
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

const OPEN_OFFER_WHERE: Prisma.JobOfferWhereInput = {
  status: { in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED] },
  deleted_at: null,
};

export type RetrievalPlace = {
  countryCode: string | null;
  city: string | null;
};

type GeoFilter<W> = { country: W; city: W | null };

const sameText = (value: string) => ({
  equals: value,
  mode: Prisma.QueryMode.insensitive,
});

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

@Injectable()
export class CandidateSourceService {
  private readonly logger = new Logger(CandidateSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
  ) {}

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

  async workersFromAll(
    opts: WorkerQueryOptions,
    limit: number,
  ): Promise<WorkerCandidate[]> {
    return this.queryWorkers(eligibleWorkerWhere(opts), limit, opts.near);
  }

  private async queryWorkers(
    where: Prisma.ProfileWhereInput,
    limit: number,
    near: RetrievalPlace | null | undefined,
  ): Promise<WorkerCandidate[]> {
    const rows = await nearFirst(
      workerGeo(near),
      limit * POOL_FACTOR,
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
      this.logger.warn('quality prior failed', err);
    }
    return out;
  }

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

  private async paidUnlockCounts(
    profileIds: string[],
    side: 'worker' | 'employer',
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
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
          deleted_at: null,
          applied_at: { lte: threshold },
        },
        select: { profile_id: true },
        distinct: ['profile_id'],
      });
      return new Set(rows.map((r) => r.profile_id));
    } catch (err) {
      this.logger.warn('hardBlockedWorkerIds failed', err);
      return new Set();
    }
  }

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

function topKeys(affinity: Record<string, number>, max: number): string[] {
  return Object.entries(affinity)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => k);
}
