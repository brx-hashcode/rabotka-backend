import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  AgentLeadStatus,
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
import { pageByTier } from '../../common/queries/text-search';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MatchingService } from '../matching/matching.service';
import { rankWorkersForOffer } from '../matching/rank-workers-for-offer';
import { EngineRolloutService } from '../recommendation-engine/engine-rollout.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { AgentLeadService } from './agent-lead.service';
import {
  AGENT_CANDIDATE_SELECT,
  AGENT_JOB_SELECT,
  PUBLIC_JOB_DETAIL_SELECT,
  PUBLIC_JOB_SELECT,
  toAgentCandidate,
  toAgentJob,
  toPublicJob,
  toPublicJobDetail,
} from './agent-selects';
import {
  jobsInZonesWhere,
  jobsOrderBy,
  publicScopeWhere,
  withFilters,
  type JobFilters,
  type JobSort,
  type PublicJobsFilter,
  type Zone,
} from './agent-zones';
import { matchingJobTiers } from './job-search';

/** Applications that hold a seat, as `accept()` counts them. */
const SEAT_HOLDING: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.WAITING_PAYMENT,
];

/**
 * Read side of the agent app: what an agent can browse.
 *
 * Every job-scoped method re-checks the zone in the query itself rather than
 * trusting the list the agent clicked from — an id typed into the url is
 * answered exactly like one outside the territory: not found.
 */
@Injectable()
export class AgentPortalService {
  private readonly logger = new Logger(AgentPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly matching: MatchingService,
    private readonly engine: RecommendationEngineService,
    private readonly rollout: EngineRolloutService,
    private readonly leads: AgentLeadService,
  ) {}

  async listJobs(
    agentId: string,
    params: { page: number; limit: number; sort?: JobSort } & JobFilters,
  ) {
    const zones = await this.zonesOf(agentId);
    if (zones.length === 0) {
      return {
        data: [],
        total: 0,
        page: params.page,
        limit: params.limit,
        facets: { employmentType: {}, category: {}, amount: null },
      };
    }

    const scope = jobsInZonesWhere(zones);
    const { rows, total, filters } = await this.pageJobs(
      scope,
      params,
      AGENT_JOB_SELECT,
      params,
    );
    const facets = await this.jobFacets(scope, filters, { withAmount: true });

    const filled = await this.filledSeats(rows.map((r) => r.id));
    return {
      data: rows.map((r) => toAgentJob(r, filled.get(r.id) ?? 0)),
      total,
      page: params.page,
      limit: params.limit,
      facets,
    };
  }

  /** Every open job, for the agent app's public front page. No session. */
  async listPublicJobs(
    params: { page: number; limit: number; sort?: JobSort } & PublicJobsFilter,
  ) {
    const scope = publicScopeWhere(params);
    // Pay is never part of the public feed, not even as a filter: a range
    // query would let anyone bisect an offer's amount.
    const { rows, total, filters } = await this.pageJobs(
      scope,
      {
        q: params.q,
        employmentTypes: params.employmentTypes,
        categories: params.categories,
      },
      PUBLIC_JOB_SELECT,
      params,
    );
    const facets = await this.jobFacets(scope, filters, { withAmount: false });

    const filled = await this.filledSeats(rows.map((r) => r.id));
    return {
      data: rows.map((r) => toPublicJob(r, filled.get(r.id) ?? 0)),
      total,
      page: params.page,
      limit: params.limit,
      facets,
    };
  }

  /**
   * One page of jobs. With a search, the jobs that say it come first, then
   * the rest of its sectors (`matchingJobTiers`); the returned `filters`
   * carry both tiers' ids, so the facets count what the list shows.
   */
  private async pageJobs<S extends Prisma.JobOfferSelect>(
    scope: Prisma.JobOfferWhereInput,
    filters: JobFilters,
    select: S,
    params: { page: number; limit: number; sort?: JobSort },
  ): Promise<{
    rows: Prisma.JobOfferGetPayload<{ select: S }>[];
    total: number;
    filters: JobFilters;
  }> {
    const skip = (params.page - 1) * params.limit;
    const orderBy = jobsOrderBy(params.sort);
    const find = (where: Prisma.JobOfferWhereInput, s: number, take: number) =>
      this.prisma.jobOffer.findMany({
        where,
        select,
        orderBy,
        skip: s,
        take,
      }) as unknown as Promise<Prisma.JobOfferGetPayload<{ select: S }>[]>;

    const tiers = await matchingJobTiers(this.prisma, filters.q);
    if (!tiers) {
      const where = withFilters(scope, filters);
      const [total, rows] = await Promise.all([
        this.prisma.jobOffer.count({ where }),
        find(where, skip, params.limit),
      ]);
      return { rows, total, filters };
    }

    const within = (ids: string[]) =>
      withFilters(scope, { ...filters, matchingIds: ids });
    const { rows, total } = await pageByTier(tiers, skip, params.limit, {
      count: (ids) => this.prisma.jobOffer.count({ where: within(ids) }),
      rows: (ids, s, take) => find(within(ids), s, take),
    });
    return { rows, total, filters: { ...filters, matchingIds: tiers.flat() } };
  }

  /**
   * Counts for the filter sidebar. Each facet is counted with every filter
   * applied except its own, so ticking "CDD" does not zero out "Mission" —
   * the count shows what ticking that box as well would add.
   */
  private async jobFacets(
    scope: Prisma.JobOfferWhereInput,
    filters: JobFilters,
    { withAmount }: { withAmount: boolean },
  ) {
    const [types, categories, amount] = await Promise.all([
      this.prisma.jobOffer.groupBy({
        by: ['employment_type'],
        where: withFilters(scope, { ...filters, employmentTypes: undefined }),
        _count: { _all: true },
      }),
      this.prisma.jobOffer.groupBy({
        by: ['category_id'],
        where: withFilters(scope, { ...filters, categories: undefined }),
        _count: { _all: true },
      }),
      withAmount
        ? this.prisma.jobOffer.aggregate({
            where: withFilters(scope, {
              ...filters,
              minAmount: undefined,
              maxAmount: undefined,
            }),
            _min: { amount: true },
            _max: { amount: true },
          })
        : null,
    ]);

    const categoryIds = categories
      .map((c) => c.category_id)
      .filter((id): id is string => id !== null);
    const slugs = categoryIds.length
      ? await this.prisma.jobCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, slug: true },
        })
      : [];
    const slugOf = new Map(slugs.map((c) => [c.id, c.slug]));

    const category: Record<string, number> = {};
    for (const c of categories) {
      const slug = c.category_id ? slugOf.get(c.category_id) : undefined;
      if (slug) category[slug] = c._count._all;
    }

    return {
      employmentType: Object.fromEntries(
        types.map((t) => [t.employment_type, t._count._all]),
      ) as Partial<Record<EmploymentType, number>>,
      category,
      ...(withAmount
        ? {
            amount:
              amount?._min.amount != null && amount._max.amount != null
                ? {
                    min: Number(amount._min.amount),
                    max: Number(amount._max.amount),
                  }
                : null,
          }
        : {}),
    };
  }

  /**
   * One open job as anyone sees it (PUBLIC_JOB_DETAIL_SELECT: the public
   * summary plus the description). A closed, deleted or
   * unknown id is the same 404, so the endpoint reveals nothing beyond the
   * public feed.
   */
  async getPublicJob(jobOfferId: string) {
    const job = await this.prisma.jobOffer.findFirst({
      where: { AND: [publicScopeWhere({}), { id: jobOfferId }] },
      select: PUBLIC_JOB_DETAIL_SELECT,
    });
    if (!job) throw new NotFoundException('Offre introuvable');
    const filled = await this.filledSeats([job.id]);
    return toPublicJobDetail(job, filled.get(job.id) ?? 0);
  }

  async getJob(agentId: string, jobOfferId: string) {
    const job = await this.findInZones(agentId, jobOfferId, AGENT_JOB_SELECT);
    const filled = await this.filledSeats([job.id]);
    return toAgentJob(job, filled.get(job.id) ?? 0);
  }

  /**
   * Workers worth calling for one job, best first.
   *
   * Ranked exactly as the WhatsApp fan-out ranks them (rankWorkersForOffer),
   * then narrowed to people who can actually be placed: active, verified
   * workers — `ApplicationService.create` refuses anyone else — who have not
   * already applied, and whom no agent has already closed (declined or
   * unreachable). Over-fetched from the ranker so that narrowing still leaves
   * a full page.
   *
   * Each candidate comes with its lead — the record an agent claims and works
   * — created on first sight, so every worker shown can be acted on.
   */
  async getCandidates(agentId: string, jobOfferId: string, limit: number) {
    // `employer_id` is read for bucketing only and never leaves this method.
    const offer = await this.findInZones(agentId, jobOfferId, {
      id: true,
      employer_id: true,
    });

    const ranked = await rankWorkersForOffer(
      {
        matching: this.matching,
        engine: this.engine,
        rollout: this.rollout,
        logger: this.logger,
      },
      offer,
      {
        limit: Math.min(limit * 2, 100),
        minScore: await this.systemConfig.getAgentCandidateMinScore(),
        requireVerified: () => Promise.resolve(true),
      },
    );
    if (ranked.length === 0) return [];

    const ids = ranked.map((r) => r.id);
    const [profiles, applied, closed] = await Promise.all([
      this.prisma.profile.findMany({
        where: {
          id: { in: ids },
          profile_type: ProfileType.WORKER,
          status: AccountStatus.ACTIVE,
          verification_status: VerificationStatus.VERIFIED,
          deleted_at: null,
        },
        select: AGENT_CANDIDATE_SELECT,
      }),
      this.prisma.application.findMany({
        where: {
          job_offer_id: offer.id,
          worker_id: { in: ids },
          status: { not: ApplicationStatus.CANCELLED },
        },
        select: { worker_id: true },
      }),
      this.prisma.agentLead.findMany({
        where: {
          job_offer_id: offer.id,
          worker_id: { in: ids },
          status: {
            in: [AgentLeadStatus.DECLINED, AgentLeadStatus.UNREACHABLE],
          },
        },
        select: { worker_id: true },
      }),
    ]);

    const byId = new Map(profiles.map((p) => [p.id, p]));
    const excluded = new Set([
      ...applied.map((a) => a.worker_id),
      ...closed.map((l) => l.worker_id),
    ]);

    const shown = ranked
      .filter((r) => byId.has(r.id) && !excluded.has(r.id))
      .slice(0, limit);
    const leads = await this.leads.ensureLeads(
      agentId,
      offer.id,
      shown.map((r) => r.id),
    );

    return shown.map((r) => ({
      ...toAgentCandidate(byId.get(r.id)!, r.score, r.matchScore ?? null),
      lead: leads.get(r.id) ?? null,
    }));
  }

  /** One offer, only if it is open and inside the agent's zones; else 404. */
  private async findInZones<S extends Prisma.JobOfferSelect>(
    agentId: string,
    jobOfferId: string,
    select: S,
  ): Promise<Prisma.JobOfferGetPayload<{ select: S }>> {
    const zones = await this.zonesOf(agentId);
    const job =
      zones.length === 0
        ? null
        : await this.prisma.jobOffer.findFirst({
            where: { AND: [{ id: jobOfferId }, jobsInZonesWhere(zones)] },
            select,
          });
    if (!job) throw new NotFoundException('Offre introuvable');
    return job;
  }

  private zonesOf(agentId: string): Promise<Zone[]> {
    return this.prisma.agentZone.findMany({
      where: { agent_id: agentId },
      select: { country_code: true, city: true },
    });
  }

  private async filledSeats(jobIds: string[]): Promise<Map<string, number>> {
    if (jobIds.length === 0) return new Map();
    const groups = await this.prisma.application.groupBy({
      by: ['job_offer_id'],
      where: { job_offer_id: { in: jobIds }, status: { in: SEAT_HOLDING } },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.job_offer_id, g._count._all]));
  }
}
