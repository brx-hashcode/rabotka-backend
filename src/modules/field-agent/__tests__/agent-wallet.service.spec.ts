import { AgentLedgerBucket, AgentLedgerKind, Prisma } from '@prisma/client';
import { AgentWalletService } from '../agent-wallet.service';

describe('AgentWalletService', () => {
  it('computes every balance from the ledger, per bucket', async () => {
    const prisma: any = {
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
            bucket: AgentLedgerBucket.PAID_OUT,
            _sum: { amount: new Prisma.Decimal(2000) },
          },
        ]),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { amount: new Prisma.Decimal(4400) } }),
      },
    };
    const service = new AgentWalletService(prisma);

    await expect(service.getBalance('agent-1')).resolves.toEqual({
      pending: 800,
      available: 1200,
      locked: 0,
      paidOut: 2000,
      totalEarned: 4400,
    });
    expect(prisma.agentLedgerEntry.aggregate).toHaveBeenCalledWith({
      where: { agent_id: 'agent-1', kind: AgentLedgerKind.COMMISSION_EARNED },
      _sum: { amount: true },
    });
  });

  it('reports zero, not null, for an agent with no history', async () => {
    const prisma: any = {
      agentLedgerEntry: {
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
    };
    const balance = await new AgentWalletService(prisma).getBalance('a');
    expect(balance).toEqual({
      pending: 0,
      available: 0,
      locked: 0,
      paidOut: 0,
      totalEarned: 0,
    });
  });
});
