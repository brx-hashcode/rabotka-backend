import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  AgentLeadStatus,
  ApplicationStatus,
  JobOfferStatus,
  Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';
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
  PUBLIC_JOB_SELECT,
  toAgentCandidate,
  toAgentJob,
  toPublicJob,
} from './agent-selects';
import {
  jobsInZonesWhere,
  publicJobsWhere,
  type PublicJobsFilter,
  type Zone,
} from './agent-zones';

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
    params: { page: number; limit: number; q?: string },
  ) {
    const zones = await this.zonesOf(agentId);
    const empty = {
      data: [],
      total: 0,
      page: params.page,
      limit: params.limit,
    };
    if (zones.length === 0) return empty;

    const where: Prisma.JobOfferWhereInput = {
      AND: [
        jobsInZonesWhere(zones),
        ...(params.q
          ? [
              {
                OR: [
                  {
                    title: {
                      contains: params.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    reference: {
                      contains: params.q,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, rows] = await Promise.all([
      this.prisma.jobOffer.count({ where }),
      this.prisma.jobOffer.findMany({
        where,
        select: AGENT_JOB_SELECT,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);

    const filled = await this.filledSeats(rows.map((r) => r.id));
    return {
      data: rows.map((r) => toAgentJob(r, filled.get(r.id) ?? 0)),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  /** Every open job, for the agent app's public front page. No session. */
  async listPublicJobs(
    params: { page: number; limit: number } & PublicJobsFilter,
  ) {
    const where = publicJobsWhere(params);

    const [total, rows] = await Promise.all([
      this.prisma.jobOffer.count({ where }),
      this.prisma.jobOffer.findMany({
        where,
        select: PUBLIC_JOB_SELECT,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);

    const filled = await this.filledSeats(rows.map((r) => r.id));
    return {
      data: rows.map((r) => toPublicJob(r, filled.get(r.id) ?? 0)),
      total,
      page: params.page,
      limit: params.limit,
    };
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
      ...toAgentCandidate(byId.get(r.id)!, r.score),
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
