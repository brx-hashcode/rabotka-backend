import { AgentLedgerBucket, AgentStatus, Prisma } from '@prisma/client';
import { AgentStatsService } from '../agent-stats.service';

function prismaMock() {
  const queryRaw = jest
    .fn()
    // signed in last 7 days
    .mockResolvedValueOnce([{ count: 3 }])
    // coverage
    .mockResolvedValueOnce([{ open_jobs: 40, covered_jobs: 25, cities: 6 }])
    // top uncovered
    .mockResolvedValueOnce([
      { country_code: 'CG', city: 'Pointe-Noire', open_jobs: 9 },
    ]);
  return {
    agent: {
      groupBy: jest.fn().mockResolvedValue([
        { status: AgentStatus.ACTIVE, _count: { _all: 5 } },
        { status: AgentStatus.SUSPENDED, _count: { _all: 1 } },
        { status: AgentStatus.REVOKED, _count: { _all: 2 } },
      ]),
      count: jest.fn().mockResolvedValue(2),
    },
    agentLedgerEntry: {
      groupBy: jest.fn().mockResolvedValue([
        {
          bucket: AgentLedgerBucket.PENDING,
          _sum: { amount: new Prisma.Decimal(800) },
        },
        {
          bucket: AgentLedgerBucket.AVAILABLE,
          _sum: { amount: new Prisma.Decimal(1200) },
        },
        {
          bucket: AgentLedgerBucket.LOCKED,
          _sum: { amount: new Prisma.Decimal(400) },
        },
        {
          bucket: AgentLedgerBucket.PAID_OUT,
          _sum: { amount: new Prisma.Decimal(5000) },
        },
      ]),
    },
    $queryRaw: queryRaw,
  };
}

describe('AgentStatsService', () => {
  it('assembles the four headline figures', async () => {
    const prisma = prismaMock();
    const stats = await new AgentStatsService(prisma as any).getStats(true);

    expect(stats.agents).toEqual({
      total: 8,
      active: 5,
      suspended: 1,
      revoked: 2,
    });
    expect(stats.engagement).toEqual({
      signedInLast7Days: 3,
      neverSignedIn: 2,
    });
    expect(stats.coverage).toEqual({
      openJobs: 40,
      coveredJobs: 25,
      citiesCovered: 6,
      topUncovered: { countryCode: 'CG', city: 'Pointe-Noire', openJobs: 9 },
    });
    // Owed = pending + available + in withdrawal; paid out is apart.
    expect(stats.money).toEqual({ owed: 2400, available: 1200, paidOut: 5000 });
  });

  it('leaves money out, without querying it, for roles that may not see it', async () => {
    const prisma = prismaMock();
    const stats = await new AgentStatsService(prisma as any).getStats(false);

    expect(stats.money).toBeUndefined();
    expect(prisma.agentLedgerEntry.groupBy).not.toHaveBeenCalled();
  });

  it('only counts never-signed-in among ACTIVE agents', async () => {
    const prisma = prismaMock();
    await new AgentStatsService(prisma as any).getStats(false);
    expect(prisma.agent.count).toHaveBeenCalledWith({
      where: { status: AgentStatus.ACTIVE, last_login_at: null },
    });
  });
});

describe('AgentStatsService – timeseries', () => {
  const rows = [
    {
      date: '2026-10-01',
      created: 1,
      active_agents: 2,
      earned: 400,
      paid_out: 0,
    },
    {
      date: '2026-10-02',
      created: 2,
      active_agents: 3,
      earned: 800,
      paid_out: 2000,
    },
  ];

  it('maps every day and totals the range', async () => {
    const prisma: any = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ n: 4 }]),
    };
    const result = await new AgentStatsService(prisma).getTimeseries(7, true);

    expect(result.points).toEqual([
      {
        date: '2026-10-01',
        created: 1,
        activeAgents: 2,
        earned: 400,
        paidOut: 0,
      },
      {
        date: '2026-10-02',
        created: 2,
        activeAgents: 3,
        earned: 800,
        paidOut: 2000,
      },
    ]);
    // Active agents is DISTINCT over the range (4), not 2 + 3.
    expect(result.totals).toEqual({
      created: 3,
      activeAgents: 4,
      earned: 1200,
      paidOut: 2000,
    });
  });

  it('drops the money series for roles that may not see it', async () => {
    const prisma: any = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ n: 4 }]),
    };
    const result = await new AgentStatsService(prisma).getTimeseries(7, false);
    expect(result.points[0]).not.toHaveProperty('earned');
    expect(result.totals).not.toHaveProperty('paidOut');
  });
});
