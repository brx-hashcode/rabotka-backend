import { Injectable } from '@nestjs/common';
import { AgentLeadStatus, AgentLedgerKind } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { PLACEMENT_GROUPS } from './agent-lead.service';
import { startOfBrazzavilleMonth } from './agent-withdrawal.service';

const STATS_TIMEZONE = 'Africa/Brazzaville';

/** The ranges the account page's chart offers, in days. */
export const SELF_STATS_RANGES = [30, 90] as const;
export type SelfStatsRange = (typeof SELF_STATS_RANGES)[number];

export type AgentSelfStats = {
  placements: { total: number; thisMonth: number; active: number };
  /** The agent's leads by where they stand now. */
  pipeline: Record<
    'claimed' | 'invited' | 'confirmed' | 'declined' | 'unreachable',
    number
  >;
  calls: { total: number; last30Days: number };
  /** Confirmed over every lead the agent worked; null before the first one. */
  conversion: number | null;
  earnings: { thisMonth: number; lastMonth: number };
  days: SelfStatsRange;
  /** One point per Brazzaville day of the range, zeros included. */
  timeseries: { date: string; placements: number; earned: number }[];
};

/**
 * The signed-in agent's own figures, for the account page. Money comes from
 * the ledger (COMMISSION_EARNED), so it agrees with the wallet.
 */
@Injectable()
export class AgentSelfStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(agentId: string, days: SelfStatsRange): Promise<AgentSelfStats> {
    const now = new Date();
    const monthStart = startOfBrazzavilleMonth(now);
    const lastMonthStart = startOfBrazzavilleMonth(
      new Date(monthStart.getTime() - 1),
    );
    const placed = { agent_id: agentId, deleted_at: null };
    const earnedIn = (gte: Date, lt?: Date) =>
      this.prisma.agentLedgerEntry.aggregate({
        where: {
          agent_id: agentId,
          kind: AgentLedgerKind.COMMISSION_EARNED,
          created_at: { gte, ...(lt ? { lt } : {}) },
        },
        _sum: { amount: true },
      });

    const [
      total,
      thisMonth,
      active,
      leads,
      calls,
      recentCalls,
      earnedThisMonth,
      earnedLastMonth,
      series,
    ] = await Promise.all([
      this.prisma.application.count({ where: placed }),
      this.prisma.application.count({
        where: { ...placed, created_at: { gte: monthStart } },
      }),
      this.prisma.application.count({
        where: { ...placed, status: { in: [...PLACEMENT_GROUPS.active] } },
      }),
      this.prisma.agentLead.groupBy({
        by: ['status'],
        where: { claimed_by_agent_id: agentId },
        _count: { _all: true },
      }),
      this.prisma.agentCallLog.count({ where: { agent_id: agentId } }),
      this.prisma.agentCallLog.count({
        where: {
          agent_id: agentId,
          created_at: { gte: new Date(now.getTime() - 30 * 86_400_000) },
        },
      }),
      earnedIn(monthStart),
      earnedIn(lastMonthStart, monthStart),
      this.timeseries(agentId, days),
    ]);

    const leadCount = (status: AgentLeadStatus) =>
      leads.find((l) => l.status === status)?._count._all ?? 0;
    const pipeline = {
      claimed: leadCount(AgentLeadStatus.CLAIMED),
      invited: leadCount(AgentLeadStatus.INVITED),
      confirmed: leadCount(AgentLeadStatus.CONFIRMED),
      declined: leadCount(AgentLeadStatus.DECLINED),
      unreachable: leadCount(AgentLeadStatus.UNREACHABLE),
    };
    const worked = Object.values(pipeline).reduce((a, n) => a + n, 0);

    return {
      placements: { total, thisMonth, active },
      pipeline,
      calls: { total: calls, last30Days: recentCalls },
      conversion: worked > 0 ? pipeline.confirmed / worked : null,
      earnings: {
        thisMonth: Number(earnedThisMonth._sum.amount ?? 0),
        lastMonth: Number(earnedLastMonth._sum.amount ?? 0),
      },
      days,
      timeseries: series,
    };
  }

  /**
   * Placements and commission earned per Brazzaville day. Timestamps are
   * stored as UTC without a zone, so each is read AT TIME ZONE 'UTC' first —
   * as in `AgentStatsService.getTimeseries`.
   */
  private async timeseries(agentId: string, days: SelfStatsRange) {
    const rows = await this.prisma.$queryRaw<
      { date: string; placements: number; earned: number }[]
    >`
      WITH bounds AS (
        SELECT (now() AT TIME ZONE ${STATS_TIMEZONE})::date AS last_day,
               (now() AT TIME ZONE ${STATS_TIMEZONE})::date - (${days}::int - 1) AS first_day
      ),
      days AS (
        SELECT generate_series(b.first_day, b.last_day, interval '1 day')::date AS d
        FROM bounds b
      ),
      placed AS (
        SELECT (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date AS d,
               COUNT(*)::int AS n
        FROM applications a, bounds b
        WHERE a.agent_id = ${agentId}::uuid
          AND a.deleted_at IS NULL
          AND (a.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date >= b.first_day
        GROUP BY 1
      ),
      money AS (
        SELECT (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date AS d,
               COALESCE(SUM(e.amount), 0)::float AS earned
        FROM agent_ledger_entries e, bounds b
        WHERE e.agent_id = ${agentId}::uuid
          AND e.kind = 'COMMISSION_EARNED'
          AND (e.created_at AT TIME ZONE 'UTC' AT TIME ZONE ${STATS_TIMEZONE})::date >= b.first_day
        GROUP BY 1
      )
      SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
             COALESCE(placed.n, 0) AS placements,
             COALESCE(money.earned, 0) AS earned
      FROM days
      LEFT JOIN placed ON placed.d = days.d
      LEFT JOIN money ON money.d = days.d
      ORDER BY days.d
    `;
    return rows.map((r) => ({
      date: r.date,
      placements: Number(r.placements),
      earned: Number(r.earned),
    }));
  }
}
