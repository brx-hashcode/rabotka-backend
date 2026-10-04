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

  /**
   * The ledger read as events. One movement writes one to three rows (a
   * release is −PENDING and +AVAILABLE); they share their kind and what they
   * are about, so they are grouped back into one line, with what it concerns:
   * the worker and job of a commission, the payout details of a withdrawal.
   *
   * `forAdmin` adds who processed a withdrawal; the agent app does not get
   * staff names.
   */
  async listMovements(
    agentId: string,
    page: number,
    limit: number,
    options: { forAdmin?: boolean } = {},
  ) {
    const [countRow] = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM (
        SELECT 1 FROM agent_ledger_entries
        WHERE agent_id = ${agentId}::uuid
        GROUP BY kind, reference_type, reference_id
      ) g
    `;
    const groups = await this.prisma.$queryRaw<
      {
        kind: AgentLedgerKind;
        reference_type: string;
        reference_id: string | null;
        at: Date;
        moves: Record<string, string | number>;
        description: string | null;
      }[]
    >`
      SELECT kind, reference_type, reference_id,
             MIN(created_at) AS at,
             jsonb_object_agg(bucket, amount) AS moves,
             MAX(description) AS description
      FROM agent_ledger_entries
      WHERE agent_id = ${agentId}::uuid
      GROUP BY kind, reference_type, reference_id
      ORDER BY MIN(created_at) DESC, kind DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;

    const idsOf = (type: string) => [
      ...new Set(
        groups
          .filter((g) => g.reference_type === type && g.reference_id)
          .map((g) => g.reference_id!),
      ),
    ];
    const [commissions, withdrawals] = await Promise.all([
      this.commissionDetails(idsOf('commission')),
      this.withdrawalDetails(idsOf('withdrawal'), !!options.forAdmin),
    ]);

    return {
      data: groups.map((g) => {
        const moves = Object.fromEntries(
          Object.entries(g.moves ?? {}).map(([b, v]) => [b, Number(v)]),
        ) as Partial<Record<AgentLedgerBucket, number>>;
        return {
          id: `${g.kind}:${g.reference_id ?? g.at.toISOString()}`,
          kind: g.kind,
          at: g.at,
          /** Signed amount per bucket, e.g. { PENDING: -400, AVAILABLE: 400 }. */
          moves,
          /** The size of the movement, whatever direction it went. */
          amount: Math.max(...Object.values(moves).map((v) => Math.abs(v)), 0),
          description: g.description,
          referenceType: g.reference_type,
          referenceId: g.reference_id,
          commission:
            g.reference_type === 'commission' && g.reference_id
              ? (commissions.get(g.reference_id) ?? null)
              : null,
          withdrawal:
            g.reference_type === 'withdrawal' && g.reference_id
              ? (withdrawals.get(g.reference_id) ?? null)
              : null,
        };
      }),
      total: Number(countRow?.total ?? 0),
      page,
      limit,
    };
  }

  private async commissionDetails(ids: string[]) {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.agentCommission.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        reason: true,
        job_offer_id: true,
        worker_id: true,
      },
    });
    const [jobs, workers] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where: { id: { in: rows.map((r) => r.job_offer_id) } },
        select: { id: true, title: true },
      }),
      this.prisma.profile.findMany({
        where: { id: { in: rows.map((r) => r.worker_id) } },
        select: { id: true, first_name: true, last_name: true },
      }),
    ]);
    const job = new Map(jobs.map((j) => [j.id, j]));
    const worker = new Map(workers.map((w) => [w.id, w]));
    return new Map(
      rows.map((r) => {
        const w = worker.get(r.worker_id);
        return [
          r.id,
          {
            status: r.status,
            reason: r.reason,
            job: {
              id: r.job_offer_id,
              title: job.get(r.job_offer_id)?.title ?? null,
            },
            worker: {
              id: r.worker_id,
              name: w ? `${w.first_name} ${w.last_name}`.trim() : null,
            },
          },
        ];
      }),
    );
  }

  private async withdrawalDetails(ids: string[], forAdmin: boolean) {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.agentWithdrawal.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        status: true,
        momo_phone: true,
        momo_operator: true,
        provider_reference: true,
        rejection_reason: true,
        processed_at: true,
        processed_by_user_id: true,
      },
    });
    const adminIds = forAdmin
      ? [
          ...new Set(
            rows
              .map((r) => r.processed_by_user_id)
              .filter((id): id is string => !!id),
          ),
        ]
      : [];
    const admins = adminIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : [];
    const admin = new Map(
      admins.map((a) => [a.id, `${a.first_name} ${a.last_name}`.trim()]),
    );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          status: r.status,
          momoPhone: r.momo_phone,
          momoOperator: r.momo_operator,
          providerReference: r.provider_reference,
          rejectionReason: r.rejection_reason,
          processedAt: r.processed_at,
          ...(forAdmin
            ? {
                processedBy: r.processed_by_user_id
                  ? (admin.get(r.processed_by_user_id) ?? null)
                  : null,
              }
            : {}),
        },
      ]),
    );
  }
}
