import { Injectable } from '@nestjs/common';
import { AgentLedgerBucket, AgentLedgerKind } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

export type AgentBalance = {
  /** Earned, not yet withdrawable — the confirmation window is running. */
  pending: number;
  /** Withdrawable now. */
  available: number;
  /** Held by a withdrawal request an admin has not processed yet. */
  locked: number;
  /** Already transferred to the agent. */
  paidOut: number;
  /** Every commission ever earned, before cancellations. */
  totalEarned: number;
};

/**
 * Read side of an agent's money.
 *
 * Every figure is computed from `agent_ledger_entries` on read — there is no
 * stored balance to drift from its own history. Commissions and withdrawals
 * write the ledger; this only adds it up.
 */
@Injectable()
export class AgentWalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(agentId: string): Promise<AgentBalance> {
    const [byBucket, earned] = await Promise.all([
      this.prisma.agentLedgerEntry.groupBy({
        by: ['bucket'],
        where: { agent_id: agentId },
        _sum: { amount: true },
      }),
      this.prisma.agentLedgerEntry.aggregate({
        where: {
          agent_id: agentId,
          kind: AgentLedgerKind.COMMISSION_EARNED,
        },
        _sum: { amount: true },
      }),
    ]);

    const sumOf = (bucket: AgentLedgerBucket) =>
      Number(byBucket.find((b) => b.bucket === bucket)?._sum.amount ?? 0);

    return {
      pending: sumOf(AgentLedgerBucket.PENDING),
      available: sumOf(AgentLedgerBucket.AVAILABLE),
      locked: sumOf(AgentLedgerBucket.LOCKED),
      paidOut: sumOf(AgentLedgerBucket.PAID_OUT),
      totalEarned: Number(earned._sum.amount ?? 0),
    };
  }

  async listEntries(agentId: string, page: number, limit: number) {
    const where = { agent_id: agentId };
    const [total, rows] = await Promise.all([
      this.prisma.agentLedgerEntry.count({ where }),
      this.prisma.agentLedgerEntry.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          created_at: true,
          kind: true,
          bucket: true,
          amount: true,
          reference_type: true,
          reference_id: true,
          description: true,
        },
      }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        kind: r.kind,
        bucket: r.bucket,
        amount: Number(r.amount),
        referenceType: r.reference_type,
        referenceId: r.reference_id,
        description: r.description,
      })),
      total,
      page,
      limit,
    };
  }
}
