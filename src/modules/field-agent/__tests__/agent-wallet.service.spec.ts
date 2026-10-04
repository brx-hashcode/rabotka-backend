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

  describe('listMovements', () => {
    const at = new Date('2026-10-04T08:24:00Z');
    function prismaWith() {
      return {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ total: 2n }])
          .mockResolvedValueOnce([
            {
              kind: AgentLedgerKind.WITHDRAWAL_PAID,
              reference_type: 'withdrawal',
              reference_id: 'wd-1',
              at,
              moves: { LOCKED: '-1000.00', PAID_OUT: '1000.00' },
              description: null,
            },
            {
              kind: AgentLedgerKind.COMMISSION_RELEASED,
              reference_type: 'commission',
              reference_id: 'com-1',
              at,
              moves: { PENDING: '-400.00', AVAILABLE: '400.00' },
              description: null,
            },
          ]),
        agentCommission: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'com-1',
              status: 'AVAILABLE',
              reason: null,
              job_offer_id: 'job-1',
              worker_id: 'w1',
            },
          ]),
        },
        jobOffer: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'job-1', title: 'Jardinier' }]),
        },
        profile: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'w1', first_name: 'Jean', last_name: 'Test' },
            ]),
        },
        agentWithdrawal: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'wd-1',
              status: 'PAID',
              momo_phone: '+242064022567',
              momo_operator: 'MTN',
              provider_reference: 'MP-1',
              rejection_reason: null,
              processed_at: at,
              processed_by_user_id: 'admin-1',
            },
          ]),
        },
        user: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'admin-1', first_name: 'Awa', last_name: 'N' },
            ]),
        },
      };
    }

    it('reads each event once, with what it concerns', async () => {
      const prisma: any = prismaWith();
      const result = await new AgentWalletService(prisma).listMovements(
        'agent-1',
        1,
        20,
        { forAdmin: true },
      );

      expect(result.total).toBe(2);
      expect(result.data[0]).toMatchObject({
        kind: AgentLedgerKind.WITHDRAWAL_PAID,
        moves: { LOCKED: -1000, PAID_OUT: 1000 },
        amount: 1000,
        withdrawal: {
          providerReference: 'MP-1',
          momoOperator: 'MTN',
          processedBy: 'Awa N',
        },
        commission: null,
      });
      expect(result.data[1]).toMatchObject({
        moves: { PENDING: -400, AVAILABLE: 400 },
        commission: {
          worker: { id: 'w1', name: 'Jean Test' },
          job: { id: 'job-1', title: 'Jardinier' },
        },
      });
    });

    it('does not tell the agent which admin paid', async () => {
      const prisma: any = prismaWith();
      const result = await new AgentWalletService(prisma).listMovements(
        'agent-1',
        1,
        20,
      );
      expect(result.data[0].withdrawal).not.toHaveProperty('processedBy');
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
