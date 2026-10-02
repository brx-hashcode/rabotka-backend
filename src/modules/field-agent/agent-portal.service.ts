import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
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
import {
  AGENT_CANDIDATE_SELECT,
  AGENT_JOB_SELECT,
  toAgentCandidate,
  toAgentJob,
} from './agent-selects';

/** Offers an agent can still do something about. */
const OPEN_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

/** Applications that hold a seat, as `accept()` counts them. */
const SEAT_HOLDING: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.WAITING_PAYMENT,
];

type Zone = { country_code: string; city: string };

/**
 * The jobs an agent may see: open, not deleted, and located in one of their
 * zones.
 *
 * "Located" uses the same fallback the ranker does (candidate-sources.ts): the
 * offer's own city, or the employer's when the offer names none — a job is
 * usually where the person posting it is. Case-insensitive because a city
 * written before GeoService snapped spellings may differ in case only.
 *
 * Exported for the spec: this is the rule that keeps an agent inside their
 * territory, so it is asserted directly.
 */
export function jobsInZonesWhere(zones: Zone[]): Prisma.JobOfferWhereInput {
  return {
    deleted_at: null,
    status: { in: OPEN_STATUSES },
    OR: zones.flatMap((z) => [
      {
        country_code: z.country_code,
        city: { equals: z.city, mode: 'insensitive' as const },
      },
      {
        city: null,
        employer: {
          country_code: z.country_code,
          city: { equals: z.city, mode: 'insensitive' as const },
        },
      },
    ]),
  };
}

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
   * already applied. Over-fetched from the ranker so that narrowing still
   * leaves a full page.
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
    const [profiles, applied] = await Promise.all([
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
    ]);

    const byId = new Map(profiles.map((p) => [p.id, p]));
    const alreadyApplied = new Set(applied.map((a) => a.worker_id));

    return ranked
      .filter((r) => byId.has(r.id) && !alreadyApplied.has(r.id))
      .slice(0, limit)
      .map((r) => toAgentCandidate(byId.get(r.id)!, r.score));
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
