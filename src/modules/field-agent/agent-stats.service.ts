import { Injectable } from '@nestjs/common';
import { AgentLedgerBucket, AgentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

const ACTIVE_WINDOW_DAYS = 7;

export type AgentStats = {
  agents: {
    total: number;
    active: number;
    suspended: number;
    revoked: number;
  };
  engagement: {
    /** Active agents who signed in to the agent app in the last 7 days. */
    signedInLast7Days: number;
    /** Active agents who have never signed in at all. */
    neverSignedIn: number;
  };
  coverage: {
    /** Open job offers on the platform. */
    openJobs: number;
    /** Of those, the ones inside some active agent's zones. */
    coveredJobs: number;
    /** Distinct cities covered by at least one active agent. */
    citiesCovered: number;
    /** The city with the most open jobs and no active agent. */
    topUncovered: {
      countryCode: string;
      city: string;
      openJobs: number;
    } | null;
  };
  /** Omitted for roles that may not see money. */
  money?: {
    /** Pending + available + in withdrawal: what Rabotka owes its agents. */
    owed: number;
    available: number;
    paidOut: number;
  };
};

/**
 * The four headline figures of the agents list.
 *
 * "Coverage" uses the same location rule the agent app filters jobs with
 * (`jobsInZonesWhere`): the offer's own city, or the employer's when the offer
 * names none — so "covered" means "an agent can actually see it".
 */
@Injectable()
export class AgentStatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The same figures day by day, for the chart under the cards: agents
   * created, distinct agents signed in, and (money roles only) commissions
   * earned and payouts. Every day of the range is present, zeros included —
   * a missing day would draw as no bar at all and read as a gap in the data.
   *
   * Timestamps are stored as UTC without a zone, so each is read AT TIME
   * ZONE 'UTC' first and only then cut into Brazzaville days.
   */
  async getTimeseries(
    days: TimeseriesRange,
    includeMoney: boolean,
  ): Promise<AgentTimeseries> {
    const rows = await this.prisma.$queryRaw<
      {
        date: string;
        created: number;
        active_agents: number;
        earned: number;
        paid_out: number;
      }[]
    >`
      WITH bounds AS (
        SELECT (now() AT TIME ZONE ${STATS_TIMEZONE})::date AS last_day,
               (now() AT TIME ZONE ${STATS_TIMEZONE})::date - (${days}::int - 1) AS first_day
      ),
      days AS (
        SELECT generate_series(b.first_day, b.last_day, interval '1 day')::date AS d
        FROM bounds b
      ),
      created AS (
        SELECT (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date AS d,
               COUNT(*)::int AS n
        FROM agents a, bounds b
        WHERE (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date >= b.first_day
        GROUP BY 1
      ),
      active AS (
        SELECT (l.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date AS d,
               COUNT(DISTINCT l.entity_id)::int AS n
        FROM logs l, bounds b
        WHERE l.action = 'AGENT_LOGIN'
          AND l.entity_type = 'Agent'
          AND (l.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date >= b.first_day
        GROUP BY 1
      ),
      money AS (
        SELECT (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date AS d,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'COMMISSION_EARNED'), 0)::float AS earned,
               COALESCE(SUM(e.amount) FILTER (
                 WHERE e.kind = 'WITHDRAWAL_PAID' AND e.bucket = 'PAID_OUT'
               ), 0)::float AS paid_out
        FROM agent_ledger_entries e, bounds b
        WHERE (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date >= b.first_day
        GROUP BY 1
      )
      SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
             COALESCE(created.n, 0) AS created,
             COALESCE(active.n, 0) AS active_agents,
             COALESCE(money.earned, 0) AS earned,
             COALESCE(money.paid_out, 0) AS paid_out
      FROM days
      LEFT JOIN created ON created.d = days.d
      LEFT JOIN active ON active.d = days.d
      LEFT JOIN money ON money.d = days.d
      ORDER BY days.d
    `;

    // Distinct over the range: summing the daily counts would count an agent
    // who signs in every day once per day.
    const [{ n: activeOverRange }] = await this.prisma.$queryRaw<
      { n: number }[]
    >`
      SELECT COUNT(DISTINCT l.entity_id)::int AS n
      FROM logs l
      WHERE l.action = 'AGENT_LOGIN'
        AND l.entity_type = 'Agent'
        AND (l.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date
            >= (now() AT TIME ZONE ${STATS_TIMEZONE})::date - (${days}::int - 1)
    `;

    const points: AgentTimeseriesPoint[] = rows.map((r) => ({
      date: r.date,
      created: r.created,
      activeAgents: r.active_agents,
      ...(includeMoney ? { earned: r.earned, paidOut: r.paid_out } : {}),
    }));
    const sum = (key: 'created' | 'earned' | 'paid_out') =>
      rows.reduce((n, r) => n + Number(r[key]), 0);

    return {
      days,
      points,
      totals: {
        created: sum('created'),
        activeAgents: activeOverRange,
        ...(includeMoney
          ? { earned: sum('earned'), paidOut: sum('paid_out') }
          : {}),
      },
    };
  }

  async getStats(includeMoney: boolean): Promise<AgentStats> {
    const since = new Date(
      Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const [byStatus, neverSignedIn, signedIn, coverage, uncovered, money] =
      await Promise.all([
        this.prisma.agent.groupBy({ by: ['status'], _count: { _all: true } }),
        this.prisma.agent.count({
          where: { status: AgentStatus.ACTIVE, last_login_at: null },
        }),
        this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(DISTINCT l.entity_id)::int AS count
          FROM logs l
          JOIN agents a ON a.id::text = l.entity_id
          WHERE l.action = 'AGENT_LOGIN'
            AND l.entity_type = 'Agent'
            AND l.created_at >= ${since}
            AND a.status = 'ACTIVE'
        `,
        this.prisma.$queryRaw<
          { open_jobs: number; covered_jobs: number; cities: number }[]
        >`
          WITH open_jobs AS (${OPEN_JOBS_SQL}),
          covered AS (${COVERED_CITIES_SQL})
          SELECT
            (SELECT COUNT(*) FROM open_jobs)::int AS open_jobs,
            (SELECT COUNT(*) FROM open_jobs o
               WHERE EXISTS (
                 SELECT 1 FROM covered c
                 WHERE c.country_code = o.country_code AND c.city = LOWER(o.city)
               ))::int AS covered_jobs,
            (SELECT COUNT(*) FROM covered)::int AS cities
        `,
        this.prisma.$queryRaw<
          { country_code: string; city: string; open_jobs: number }[]
        >`
          WITH open_jobs AS (${OPEN_JOBS_SQL}),
          covered AS (${COVERED_CITIES_SQL})
          SELECT o.country_code, o.city, COUNT(*)::int AS open_jobs
          FROM open_jobs o
          WHERE o.city IS NOT NULL
            AND o.country_code IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM covered c
              WHERE c.country_code = o.country_code AND c.city = LOWER(o.city)
            )
          GROUP BY o.country_code, o.city
          ORDER BY open_jobs DESC, o.city ASC
          LIMIT 1
        `,
        includeMoney
          ? this.prisma.agentLedgerEntry.groupBy({
              by: ['bucket'],
              _sum: { amount: true },
            })
          : Promise.resolve(null),
      ]);

    const countOf = (status: AgentStatus) =>
      byStatus.find((s) => s.status === status)?._count._all ?? 0;
    const sumOf = (bucket: AgentLedgerBucket) =>
      Number(money?.find((b) => b.bucket === bucket)?._sum.amount ?? 0);

    const top = uncovered[0];
    return {
      agents: {
        total: byStatus.reduce((n, s) => n + s._count._all, 0),
        active: countOf(AgentStatus.ACTIVE),
        suspended: countOf(AgentStatus.SUSPENDED),
        revoked: countOf(AgentStatus.REVOKED),
      },
      engagement: {
        signedInLast7Days: signedIn[0]?.count ?? 0,
        neverSignedIn,
      },
      coverage: {
        openJobs: coverage[0]?.open_jobs ?? 0,
        coveredJobs: coverage[0]?.covered_jobs ?? 0,
        citiesCovered: coverage[0]?.cities ?? 0,
        topUncovered: top
          ? {
              countryCode: top.country_code,
              city: top.city,
              openJobs: top.open_jobs,
            }
          : null,
      },
      ...(money
        ? {
            money: {
              owed:
                sumOf(AgentLedgerBucket.PENDING) +
                sumOf(AgentLedgerBucket.AVAILABLE) +
                sumOf(AgentLedgerBucket.LOCKED),
              available: sumOf(AgentLedgerBucket.AVAILABLE),
              paidOut: sumOf(AgentLedgerBucket.PAID_OUT),
            },
          }
        : {}),
    };
  }
}

/** Daily buckets are cut on Congo time, where the agents and the admins are. */
const STATS_TIMEZONE = 'Africa/Brazzaville';

/**
 * Open offers with the location the agent app filters on: the offer's own
 * city and country, or — when the offer names no city — the employer's.
 * Mirrors `jobsInZonesWhere` in agent-portal.service.ts.
 */
const OPEN_JOBS_SQL = Prisma.sql`
    SELECT
      j.id,
      CASE WHEN j.city IS NULL THEN e.country_code ELSE j.country_code END
        AS country_code,
      COALESCE(j.city, e.city) AS city
    FROM job_offers j
    JOIN profiles e ON e.id = j.employer_id
    WHERE j.deleted_at IS NULL
      AND j.status IN ('ACTIVE', 'PARTIALLY_FILLED')
`;

/** Cities covered by at least one ACTIVE agent, lowercased for comparison. */
const COVERED_CITIES_SQL = Prisma.sql`
    SELECT DISTINCT z.country_code, LOWER(z.city) AS city
    FROM agent_zones z
    JOIN agents a ON a.id = z.agent_id
    WHERE a.status = 'ACTIVE'
`;

export const TIMESERIES_RANGES = [7, 30, 90, 180] as const;
export type TimeseriesRange = (typeof TIMESERIES_RANGES)[number];

export type AgentTimeseriesPoint = {
  /** Calendar day in Africa/Brazzaville, YYYY-MM-DD. */
  date: string;
  /** Agents created that day. */
  created: number;
  /** Distinct agents who signed in to the agent app that day. */
  activeAgents: number;
  /** Commissions earned that day, FCFA (money roles only). */
  earned?: number;
  /** Paid out to agents that day, FCFA (money roles only). */
  paidOut?: number;
};

export type AgentTimeseries = {
  days: TimeseriesRange;
  points: AgentTimeseriesPoint[];
  totals: {
    created: number;
    /** Distinct agents over the whole range, not a sum of daily counts. */
    activeAgents: number;
    earned?: number;
    paidOut?: number;
  };
};
