import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentLedgerBucket,
  AgentLedgerKind,
  AgentMomoOperator,
  AgentStatus,
  AgentWithdrawalStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { LogService } from '../log/log.service';
import { LayoutService } from '../mail/layout.service';
import { MailService } from '../mail/mail.service';
import {
  agentWithdrawalPaidEmail,
  agentWithdrawalRejectedEmail,
} from '../mail/templates';
import { SystemConfigService } from '../system-config/system-config.service';
import { toE164 } from '../whatsapp/contracts/address';

type Tx = Prisma.TransactionClient;

const WITHDRAWAL_SELECT = {
  id: true,
  created_at: true,
  amount: true,
  momo_phone: true,
  momo_operator: true,
  status: true,
  processed_at: true,
  provider_reference: true,
  rejection_reason: true,
  agent: {
    select: { id: true, first_name: true, last_name: true, avatar_url: true },
  },
} as const satisfies Prisma.AgentWithdrawalSelect;

type WithdrawalRow = Prisma.AgentWithdrawalGetPayload<{
  select: typeof WITHDRAWAL_SELECT;
}>;

function toWithdrawal(w: WithdrawalRow) {
  return {
    id: w.id,
    createdAt: w.created_at,
    amount: Number(w.amount),
    momoPhone: w.momo_phone,
    momoOperator: w.momo_operator,
    status: w.status,
    processedAt: w.processed_at,
    providerReference: w.provider_reference,
    rejectionReason: w.rejection_reason,
    agent: {
      id: w.agent.id,
      firstName: w.agent.first_name,
      lastName: w.agent.last_name,
      avatarUrl: w.agent.avatar_url,
    },
  };
}

/**
 * Agents asking to be paid, and admins paying them.
 *
 * Payment is manual: the admin sends the Mobile Money transfer, then records
 * its reference here. The ledger carries the money — requested moves it from
 * AVAILABLE to LOCKED, paid from LOCKED to PAID_OUT, rejected back to
 * AVAILABLE — in the same transaction as the status change, which is always
 * conditional on the status it starts from.
 */
@Injectable()
export class AgentWithdrawalService {
  private readonly logger = new Logger(AgentWithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly logService: LogService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  /**
   * The agent's request. Serialised per agent by a row lock, so two requests
   * sent at once cannot both spend the same balance; the partial unique index
   * `agent_withdrawals_one_open` backs the one-open-request rule.
   */
  async request(
    agentId: string,
    input: {
      amount: number;
      momoOperator: AgentMomoOperator;
      momoPhone?: string;
    },
  ) {
    const min = await this.systemConfig.getAgentWithdrawalMinFcfa();
    if (!Number.isInteger(input.amount) || input.amount < min) {
      throw new BadRequestException(
        `Le montant minimum d'un retrait est de ${min.toLocaleString('fr-FR')} FCFA.`,
      );
    }

    try {
      const withdrawal = await this.prisma.$transaction(async (tx) => {
        await this.lockAgent(tx, agentId);
        const agent = await tx.agent.findUnique({
          where: { id: agentId },
          select: { status: true, phone: true },
        });
        if (!agent) throw new NotFoundException('Agent introuvable');
        if (agent.status !== AgentStatus.ACTIVE) {
          throw new ForbiddenException(
            'Votre compte agent est suspendu : contactez Rabotka.',
          );
        }

        const open = await tx.agentWithdrawal.count({
          where: { agent_id: agentId, status: AgentWithdrawalStatus.REQUESTED },
        });
        if (open > 0) {
          throw new ConflictException(
            'Vous avez déjà une demande de retrait en cours.',
          );
        }

        const available = await this.availableIn(tx, agentId);
        if (input.amount > available) {
          throw new BadRequestException(
            `Solde disponible insuffisant (${available.toLocaleString('fr-FR')} FCFA).`,
          );
        }

        const created = await tx.agentWithdrawal.create({
          data: {
            agent_id: agentId,
            amount: input.amount,
            momo_phone: normalizeMomoPhone(input.momoPhone ?? agent.phone),
            momo_operator: input.momoOperator,
          },
          select: WITHDRAWAL_SELECT,
        });
        await this.writeLedger(tx, agentId, created.id, [
          [
            AgentLedgerKind.WITHDRAWAL_REQUESTED,
            AgentLedgerBucket.AVAILABLE,
            -input.amount,
            'requested:available',
          ],
          [
            AgentLedgerKind.WITHDRAWAL_REQUESTED,
            AgentLedgerBucket.LOCKED,
            input.amount,
            'requested:locked',
          ],
        ]);
        return created;
      });

      await this.log('AGENT_WITHDRAWAL_REQUESTED', agentId, {
        withdrawalId: withdrawal.id,
        amount: input.amount,
        momoOperator: input.momoOperator,
      });
      return toWithdrawal(withdrawal);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Vous avez déjà une demande de retrait en cours.',
        );
      }
      throw err;
    }
  }

  /** The admin sent the transfer; `reference` is its Mobile Money reference. */
  async pay(withdrawalId: string, adminId: string, reference: string) {
    const ref = reference.trim();
    if (!ref) throw new BadRequestException('La référence est obligatoire.');

    try {
      const paid = await this.prisma.$transaction(async (tx) => {
        const w = await this.requireRequested(tx, withdrawalId);
        const { count } = await tx.agentWithdrawal.updateMany({
          where: { id: w.id, status: AgentWithdrawalStatus.REQUESTED },
          data: {
            status: AgentWithdrawalStatus.PAID,
            processed_by_user_id: adminId,
            processed_at: new Date(),
            provider_reference: ref,
          },
        });
        if (count === 0) throw this.alreadyProcessed();
        const amount = Number(w.amount);
        await this.writeLedger(tx, w.agent_id, w.id, [
          [
            AgentLedgerKind.WITHDRAWAL_PAID,
            AgentLedgerBucket.LOCKED,
            -amount,
            'paid:locked',
          ],
          [
            AgentLedgerKind.WITHDRAWAL_PAID,
            AgentLedgerBucket.PAID_OUT,
            amount,
            'paid:paid_out',
          ],
        ]);
        return tx.agentWithdrawal.findUniqueOrThrow({
          where: { id: w.id },
          select: {
            ...WITHDRAWAL_SELECT,
            agent: {
              select: { ...WITHDRAWAL_SELECT.agent.select, email: true },
            },
          },
        });
      });

      const amount = Number(paid.amount);
      await this.log(
        'AGENT_WITHDRAWAL_PAID',
        paid.agent.id,
        { withdrawalId: paid.id, amount, reference: ref },
        adminId,
      );
      await this.email(
        paid.agent.email,
        'Votre retrait Rabotka a été envoyé',
        agentWithdrawalPaidEmail({
          firstName: paid.agent.first_name,
          amount,
          momoPhone: paid.momo_phone,
          reference: ref,
        }),
      );
      return toWithdrawal(paid);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'Cette référence a déjà servi pour un autre retrait.',
        );
      }
      throw err;
    }
  }

  /** The admin refused it; the money goes back to the available balance. */
  async reject(withdrawalId: string, adminId: string, reason: string) {
    const why = reason.trim();
    const rejected = await this.prisma.$transaction(async (tx) => {
      const w = await this.requireRequested(tx, withdrawalId);
      const { count } = await tx.agentWithdrawal.updateMany({
        where: { id: w.id, status: AgentWithdrawalStatus.REQUESTED },
        data: {
          status: AgentWithdrawalStatus.REJECTED,
          processed_by_user_id: adminId,
          processed_at: new Date(),
          rejection_reason: why,
        },
      });
      if (count === 0) throw this.alreadyProcessed();
      const amount = Number(w.amount);
      await this.writeLedger(tx, w.agent_id, w.id, [
        [
          AgentLedgerKind.WITHDRAWAL_REJECTED,
          AgentLedgerBucket.LOCKED,
          -amount,
          'rejected:locked',
        ],
        [
          AgentLedgerKind.WITHDRAWAL_REJECTED,
          AgentLedgerBucket.AVAILABLE,
          amount,
          'rejected:available',
        ],
      ]);
      return tx.agentWithdrawal.findUniqueOrThrow({
        where: { id: w.id },
        select: {
          ...WITHDRAWAL_SELECT,
          agent: { select: { ...WITHDRAWAL_SELECT.agent.select, email: true } },
        },
      });
    });

    const amount = Number(rejected.amount);
    await this.log(
      'AGENT_WITHDRAWAL_REJECTED',
      rejected.agent.id,
      { withdrawalId: rejected.id, amount, reason: why },
      adminId,
    );
    await this.email(
      rejected.agent.email,
      'Votre demande de retrait Rabotka',
      agentWithdrawalRejectedEmail({
        firstName: rejected.agent.first_name,
        amount,
        reason: why,
      }),
    );
    return toWithdrawal(rejected);
  }

  /** Withdrawals, newest first — one agent's, or every agent's for the queue. */
  async list(params: {
    agentId?: string;
    status?: AgentWithdrawalStatus;
    page: number;
    limit: number;
  }) {
    const where: Prisma.AgentWithdrawalWhereInput = {
      ...(params.agentId ? { agent_id: params.agentId } : {}),
      ...(params.status ? { status: params.status } : {}),
    };
    const [total, rows, open] = await Promise.all([
      this.prisma.agentWithdrawal.count({ where }),
      this.prisma.agentWithdrawal.findMany({
        where,
        select: WITHDRAWAL_SELECT,
        // The queue is worked oldest first; history reads newest first.
        orderBy: {
          created_at:
            params.status === AgentWithdrawalStatus.REQUESTED ? 'asc' : 'desc',
        },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.agentWithdrawal.aggregate({
        where: {
          ...(params.agentId ? { agent_id: params.agentId } : {}),
          status: AgentWithdrawalStatus.REQUESTED,
        },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);
    return {
      data: rows.map(toWithdrawal),
      total,
      page: params.page,
      limit: params.limit,
      /** What is waiting for an admin, whatever the filter. */
      open: { count: open._count._all, amount: Number(open._sum.amount ?? 0) },
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async lockAgent(tx: Tx, agentId: string) {
    await tx.$queryRaw`SELECT 1 FROM agents WHERE id = ${agentId}::uuid FOR UPDATE`;
  }

  private async availableIn(tx: Tx, agentId: string): Promise<number> {
    const sum = await tx.agentLedgerEntry.aggregate({
      where: { agent_id: agentId, bucket: AgentLedgerBucket.AVAILABLE },
      _sum: { amount: true },
    });
    return Number(sum._sum.amount ?? 0);
  }

  private async requireRequested(tx: Tx, withdrawalId: string) {
    const w = await tx.agentWithdrawal.findUnique({
      where: { id: withdrawalId },
      select: { id: true, agent_id: true, amount: true, status: true },
    });
    if (!w) throw new NotFoundException('Retrait introuvable');
    if (w.status !== AgentWithdrawalStatus.REQUESTED) {
      throw this.alreadyProcessed();
    }
    return w;
  }

  private alreadyProcessed() {
    return new ConflictException('Ce retrait a déjà été traité.');
  }

  private async writeLedger(
    tx: Tx,
    agentId: string,
    withdrawalId: string,
    moves: [AgentLedgerKind, AgentLedgerBucket, number, string][],
  ) {
    await tx.agentLedgerEntry.createMany({
      data: moves.map(([kind, bucket, amount, step]) => ({
        agent_id: agentId,
        kind,
        bucket,
        amount,
        reference_type: 'withdrawal',
        reference_id: withdrawalId,
        idempotency_key: `withdrawal:${withdrawalId}:${step}`,
      })),
      skipDuplicates: true,
    });
  }

  private log(
    action: string,
    agentId: string,
    metadata: Record<string, unknown>,
    adminId?: string,
  ) {
    return this.logService
      .create({
        action,
        entityType: 'Agent',
        entityId: agentId,
        ...(adminId ? { userId: adminId } : {}),
        metadata,
      })
      .catch(() => undefined);
  }

  /** Best effort: the decision is recorded whether or not the email leaves. */
  private async email(to: string, subject: string, body: string) {
    try {
      await this.mail.sendMail({
        to,
        subject,
        html: await this.layout.wrap(body, { previewText: subject }),
      });
    } catch (err) {
      this.logger.warn(`Agent withdrawal email to ${to} failed`, err);
    }
  }
}

/** The payout number as E.164, refused unless it is a plausible number. */
export function normalizeMomoPhone(raw: string): string {
  const e164 = toE164(raw);
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
    throw new BadRequestException('Numéro Mobile Money invalide.');
  }
  return e164;
}
