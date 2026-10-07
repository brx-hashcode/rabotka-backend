import { AgentLeadStatus, Prisma } from '@prisma/client';
import { AgentSelfStatsService } from '../agent-self-stats.service';

function prismaMock(leads: { status: AgentLeadStatus; n: number }[]) {
  return {
    application: {
      count: jest
        .fn()
        .mockResolvedValueOnce(12) // total
        .mockResolvedValueOnce(3) // this month
        .mockResolvedValueOnce(5), // active
    },
    agentLead: {
      groupBy: jest
        .fn()
        .mockResolvedValue(
          leads.map((l) => ({ status: l.status, _count: { _all: l.n } })),
        ),
    },
    agentCallLog: {
      count: jest.fn().mockResolvedValueOnce(40).mockResolvedValueOnce(9),
    },
    agentLedgerEntry: {
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({ _sum: { amount: new Prisma.Decimal(1200) } })
        .mockResolvedValueOnce({ _sum: { amount: null } }),
    },
    $queryRaw: jest.fn().mockResolvedValue([
      { date: '2026-10-05', placements: 1, earned: 0 },
      { date: '2026-10-06', placements: 2, earned: 800 },
    ]),
  };
}

describe('AgentSelfStatsService', () => {
  it("assembles the agent's own figures", async () => {
    const prisma = prismaMock([
      { status: AgentLeadStatus.CLAIMED, n: 2 },
      { status: AgentLeadStatus.CONFIRMED, n: 3 },
      { status: AgentLeadStatus.DECLINED, n: 1 },
    ]);
    const stats = await new AgentSelfStatsService(prisma as any).get(
      'agent-1',
      30,
    );

    expect(stats.placements).toEqual({ total: 12, thisMonth: 3, active: 5 });
    expect(stats.pipeline).toEqual({
      claimed: 2,
      invited: 0,
      confirmed: 3,
      declined: 1,
      unreachable: 0,
    });
    expect(stats.conversion).toBe(0.5);
    expect(stats.calls).toEqual({ total: 40, last30Days: 9 });
    expect(stats.earnings).toEqual({ thisMonth: 1200, lastMonth: 0 });
    expect(stats.timeseries).toEqual([
      { date: '2026-10-05', placements: 1, earned: 0 },
      { date: '2026-10-06', placements: 2, earned: 800 },
    ]);
    // Only this agent's rows.
    expect(prisma.application.count.mock.calls[0][0].where).toEqual({
      agent_id: 'agent-1',
      deleted_at: null,
    });
    expect(prisma.agentLead.groupBy.mock.calls[0][0].where).toEqual({
      claimed_by_agent_id: 'agent-1',
    });
  });

  it('has no conversion rate before the first lead', async () => {
    const stats = await new AgentSelfStatsService(prismaMock([]) as any).get(
      'agent-1',
      90,
    );
    expect(stats.conversion).toBeNull();
    expect(stats.days).toBe(90);
  });
});
