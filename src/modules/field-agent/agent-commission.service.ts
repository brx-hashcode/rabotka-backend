import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentCommissionStatus,
  AgentLedgerBucket,
  AgentLedgerKind,
  AgentStatus,
  AssignmentStatus,
  ContactUnlockStatus,
  PaymentRequestStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { isEmployerCoveredAtJobLevel } from '../contact-unlock/employer-coverage';
import { LogService } from '../log/log.service';
import {
  type AgentCommissionSettings,
  SystemConfigService,
} from '../system-config/system-config.service';
import {
  CANCELLING_ASSIGNMENT_STATUSES,
  addHours,
  decideCommission,
} from './agent-commission-rules';
import { AgentNotificationService } from './agent-notification.service';

/** How many placements one sweep decides, and how many it releases. */
const SWEEP_BATCH = 200;

type Tx = Prisma.TransactionClient;

type LedgerMove = {
  kind: AgentLedgerKind;
  bucket: AgentLedgerBucket;
  amount: number;
  key: string;
  description?: string;
};

/** What `rules_snapshot` holds: the settings applied, and the facts seen. */
type RulesSnapshot = AgentCommissionSettings & {
  facts?: Record<string, unknown>;
};

/**
 * An agent's earnings: one commission per placement.
 *
 * Driven by a sweep rather than by the payment code. A placement is an
 * application created from an agent's invitation (`applications.agent_id`)
 * whose contact unlock reached UNLOCKED; the sweep finds the ones not decided
 * yet, decides each once (`application_id` is unique), then moves pending
 * commissions on: released when their window has passed, cancelled when the
 * mission was cancelled or a no-show. Contact-unlock knows nothing about
 * agents.
 *
 * Every status change is a conditional update on the status it starts from,
 * in the same transaction as its ledger rows, and every ledger row has an
 * idempotency key — so a sweep that runs twice, or concurrently, moves no
 * money twice.
 */
@Injectable()
export class AgentCommissionService {
  private readonly logger = new Logger(AgentCommissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly logService: LogService,
    private readonly notifications: AgentNotificationService,
  ) {}

  async sweep(now = new Date()) {
    const decided = await this.decideNewPlacements(now);
    const started = await this.startCompletionWindows();
    const { released, cancelled } = await this.settlePending(now);
    return { decided, started, released, cancelled };
  }

  // ── 1. decide ─────────────────────────────────────────────────────────────

  /** Unlocked agent placements that have no commission row yet. */
  private async undecidedAttemptIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT a.id
      FROM contact_unlock_attempts a
      JOIN applications ap ON ap.id = a.application_id
      LEFT JOIN agent_commissions c ON c.application_id = a.application_id
      WHERE a.status = 'UNLOCKED'
        AND ap.agent_id IS NOT NULL
        AND c.id IS NULL
      ORDER BY a.unlocked_at ASC NULLS LAST
      LIMIT ${SWEEP_BATCH}
    `;
    return rows.map((r) => r.id);
  }

  async decideNewPlacements(now = new Date()): Promise<number> {
    const ids = await this.undecidedAttemptIds();
    if (ids.length === 0) return 0;
    const settings = await this.systemConfig.getAgentCommissionSettings();

    let decided = 0;
    for (const id of ids) {
      try {
        if (await this.decideOne(id, settings, now)) decided++;
      } catch (err) {
        // One bad row must not stall every placement behind it.
        this.logger.error(`Commission decision failed for unlock ${id}`, err);
      }
    }
    return decided;
  }

  private async decideOne(
    attemptId: string,
    settings: AgentCommissionSettings,
    now: Date,
  ): Promise<boolean> {
    const attempt = await this.prisma.contactUnlockAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true,
        status: true,
        application_id: true,
        job_offer_id: true,
        worker_id: true,
        employer_id: true,
        unlocked_at: true,
        application: { select: { agent_id: true } },
        job_offer: { select: { quantity: true, employer_unlock_paid: true } },
        worker: { select: { phone: true, direct_phone: true } },
        employer: { select: { phone: true } },
      },
    });
    const agentId = attempt?.application.agent_id;
    if (!attempt || !agentId || attempt.status !== ContactUnlockStatus.UNLOCKED)
      return false;

    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { status: true, phone: true },
    });
    if (!agent) return false;

    const coveredAtJobLevel = isEmployerCoveredAtJobLevel(
      attempt.job_offer.quantity,
      attempt.job_offer.employer_unlock_paid,
    );
    // The employer's payment is on this unlock — or, when one payment covered
    // every seat, on whichever unlock of the job it was made from.
    const employerAttemptIds = coveredAtJobLevel
      ? (
          await this.prisma.contactUnlockAttempt.findMany({
            where: { job_offer_id: attempt.job_offer_id },
            select: { id: true },
          })
        ).map((a) => a.id)
      : [attempt.id];
    const payments = await this.prisma.paymentRequest.findMany({
      where: {
        status: PaymentRequestStatus.APPROVED,
        deleted_at: null,
        OR: [
          {
            profile_id: attempt.worker_id,
            contact_unlock_attempt_id: attempt.id,
          },
          {
            profile_id: attempt.employer_id,
            contact_unlock_attempt_id: { in: employerAttemptIds },
          },
        ],
      },
      select: {
        profile_id: true,
        request_type: true,
        contact_unlock_attempt_id: true,
      },
    });
    // A wallet-funded unlock writes a synthetic request with no
    // `request_type` (recordWalletUnlockPayment); only a typed one is money
    // that actually arrived — the same test the parrainage uses.
    const momo = (p: (typeof payments)[number]) => p.request_type !== null;
    const workerPays = payments.filter(
      (p) => p.profile_id === attempt.worker_id,
    );
    const employerPays = payments.filter(
      (p) => p.profile_id === attempt.employer_id,
    );

    const facts = {
      agentActive: agent.status === AgentStatus.ACTIVE,
      agentPhone: agent.phone,
      workerPhones: [attempt.worker.phone, attempt.worker.direct_phone],
      employerPhone: attempt.employer.phone,
      employerCoveredAtJobLevel: coveredAtJobLevel,
      workerPaidMomo: workerPays.some(momo),
      employerPaidMomo: employerPays.some(momo),
      carriesEmployerPayment: employerPays.some(
        (p) => p.contact_unlock_attempt_id === attempt.id,
      ),
    };
    const decision = decideCommission(facts, settings);
    // Phones are not kept in the snapshot: the admin sees the reason, and the
    // numbers are on the profiles.
    const snapshot: RulesSnapshot = {
      ...settings,
      facts: {
        agentActive: facts.agentActive,
        employerCoveredAtJobLevel: facts.employerCoveredAtJobLevel,
        workerPaidMomo: facts.workerPaidMomo,
        employerPaidMomo: facts.employerPaidMomo,
        carriesEmployerPayment: facts.carriesEmployerPayment,
      },
    };
    const base = {
      agent_id: agentId,
      application_id: attempt.application_id,
      contact_unlock_attempt_id: attempt.id,
      job_offer_id: attempt.job_offer_id,
      worker_id: attempt.worker_id,
      rules_snapshot: snapshot as unknown as Prisma.InputJsonValue,
    };

    try {
      if (!decision.eligible) {
        await this.prisma.agentCommission.create({
          data: {
            ...base,
            amount: 0,
            status: AgentCommissionStatus.INELIGIBLE,
            reason: decision.reason,
          },
        });
        await this.log('AGENT_COMMISSION_INELIGIBLE', agentId, attempt, {
          reason: decision.reason,
        });
        return true;
      }

      const unlockedAt = attempt.unlocked_at ?? now;
      const commission = await this.prisma.$transaction(async (tx) => {
        const created = await tx.agentCommission.create({
          data: {
            ...base,
            amount: settings.amountFcfa,
            status: AgentCommissionStatus.PENDING,
            available_at:
              settings.releaseEvent === 'UNLOCKED'
                ? addHours(unlockedAt, settings.confirmationHours)
                : null,
          },
        });
        await this.writeLedger(tx, agentId, created.id, [
          {
            kind: AgentLedgerKind.COMMISSION_EARNED,
            bucket: AgentLedgerBucket.PENDING,
            amount: settings.amountFcfa,
            key: `commission:${created.id}:earned`,
          },
        ]);
        return created;
      });
      await this.log('AGENT_COMMISSION_EARNED', agentId, attempt, {
        commissionId: commission.id,
        amount: settings.amountFcfa,
      });
      const names = await this.placementNames(
        attempt.job_offer_id,
        attempt.worker_id,
      );
      await this.notifications.notify(
        agentId,
        { type: 'COMMISSION_EARNED', amount: settings.amountFcfa, ...names },
        `commission:${commission.id}:earned`,
      );
      return true;
    } catch (err) {
      // Another sweep decided this placement first.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return false;
      }
      throw err;
    }
  }

  // ── 2. start the window (release event COMPLETED) ─────────────────────────

  async startCompletionWindows(): Promise<number> {
    const waiting = await this.prisma.agentCommission.findMany({
      where: { status: AgentCommissionStatus.PENDING, available_at: null },
      select: { id: true, application_id: true, rules_snapshot: true },
      take: SWEEP_BATCH,
    });
    if (waiting.length === 0) return 0;

    const completed = await this.prisma.assignment.findMany({
      where: {
        application_id: { in: waiting.map((c) => c.application_id) },
        status: AssignmentStatus.COMPLETED,
        completed_at: { not: null },
      },
      select: { application_id: true, completed_at: true },
    });
    const doneAt = new Map(
      completed.map((a) => [a.application_id, a.completed_at!]),
    );

    let started = 0;
    for (const c of waiting) {
      const at = doneAt.get(c.application_id);
      if (!at) continue;
      // The window it was earned under, not today's setting.
      const hours = Number(
        (c.rules_snapshot as RulesSnapshot | null)?.confirmationHours ?? 0,
      );
      const { count } = await this.prisma.agentCommission.updateMany({
        where: {
          id: c.id,
          status: AgentCommissionStatus.PENDING,
          available_at: null,
        },
        data: { available_at: addHours(at, hours) },
      });
      started += count;
    }
    return started;
  }

  // ── 3. release or cancel ──────────────────────────────────────────────────

  async settlePending(now = new Date()) {
    const pending = await this.prisma.agentCommission.findMany({
      where: { status: AgentCommissionStatus.PENDING },
      select: {
        id: true,
        agent_id: true,
        application_id: true,
        contact_unlock_attempt_id: true,
        job_offer_id: true,
        worker_id: true,
        amount: true,
        available_at: true,
      },
      orderBy: { available_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (pending.length === 0) return { released: 0, cancelled: 0 };

    const assignments = await this.prisma.assignment.findMany({
      where: { application_id: { in: pending.map((c) => c.application_id) } },
      select: { application_id: true, status: true },
    });
    const statusOf = new Map(
      assignments.map((a) => [a.application_id, a.status]),
    );

    let released = 0;
    let cancelled = 0;
    for (const c of pending) {
      const assignment = statusOf.get(c.application_id);
      try {
        if (assignment && CANCELLING_ASSIGNMENT_STATUSES.includes(assignment)) {
          const reason =
            assignment === AssignmentStatus.NO_SHOW
              ? 'Le travailleur ne s’est pas présenté'
              : 'Mission annulée';
          if (await this.cancel(c, AgentCommissionStatus.PENDING, reason)) {
            cancelled++;
          }
        } else if (c.available_at && c.available_at <= now) {
          if (await this.release(c, now)) released++;
        }
      } catch (err) {
        this.logger.error(`Commission ${c.id} could not be settled`, err);
      }
    }
    return { released, cancelled };
  }

  private async release(
    c: {
      id: string;
      agent_id: string;
      amount: Prisma.Decimal;
      job_offer_id: string;
      worker_id: string;
      contact_unlock_attempt_id: string;
    },
    now: Date,
  ): Promise<boolean> {
    const amount = Number(c.amount);
    const moved = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.agentCommission.updateMany({
        where: { id: c.id, status: AgentCommissionStatus.PENDING },
        data: { status: AgentCommissionStatus.AVAILABLE, released_at: now },
      });
      if (count === 0) return false;
      await this.writeLedger(tx, c.agent_id, c.id, [
        {
          kind: AgentLedgerKind.COMMISSION_RELEASED,
          bucket: AgentLedgerBucket.PENDING,
          amount: -amount,
          key: `commission:${c.id}:released:pending`,
        },
        {
          kind: AgentLedgerKind.COMMISSION_RELEASED,
          bucket: AgentLedgerBucket.AVAILABLE,
          amount,
          key: `commission:${c.id}:released:available`,
        },
      ]);
      return true;
    });
    if (moved) {
      await this.log('AGENT_COMMISSION_RELEASED', c.agent_id, c, {
        commissionId: c.id,
        amount,
      });
      await this.notifications.notify(
        c.agent_id,
        {
          type: 'COMMISSION_AVAILABLE',
          amount,
          ...(await this.placementNames(c.job_offer_id, c.worker_id)),
        },
        `commission:${c.id}:available`,
      );
    }
    return moved;
  }

  /**
   * Takes a commission back from the bucket it sits in. From AVAILABLE only
   * while the agent still has that much available — money already locked in
   * a withdrawal or paid out is not clawed back here.
   */
  private async cancel(
    c: {
      id: string;
      agent_id: string;
      amount: Prisma.Decimal;
      job_offer_id: string;
      worker_id: string;
      contact_unlock_attempt_id: string;
    },
    from: AgentCommissionStatus,
    reason: string,
    adminId?: string,
  ): Promise<boolean> {
    const amount = Number(c.amount);
    const bucket =
      from === AgentCommissionStatus.AVAILABLE
        ? AgentLedgerBucket.AVAILABLE
        : AgentLedgerBucket.PENDING;

    const moved = await this.prisma.$transaction(async (tx) => {
      if (from === AgentCommissionStatus.AVAILABLE) {
        // Serialises this agent's money movements while the balance is read.
        await tx.$queryRaw`SELECT 1 FROM agents WHERE id = ${c.agent_id}::uuid FOR UPDATE`;
        const sum = await tx.agentLedgerEntry.aggregate({
          where: { agent_id: c.agent_id, bucket: AgentLedgerBucket.AVAILABLE },
          _sum: { amount: true },
        });
        if (Number(sum._sum.amount ?? 0) < amount) {
          throw new ConflictException(
            "Le solde disponible de l'agent ne couvre plus cette commission.",
          );
        }
      }
      const { count } = await tx.agentCommission.updateMany({
        where: { id: c.id, status: from },
        data: {
          status: AgentCommissionStatus.CANCELLED,
          cancelled_at: new Date(),
          reason,
        },
      });
      if (count === 0) return false;
      await this.writeLedger(tx, c.agent_id, c.id, [
        {
          kind: AgentLedgerKind.COMMISSION_CANCELLED,
          bucket,
          amount: -amount,
          key: `commission:${c.id}:cancelled`,
          description: reason,
        },
      ]);
      return true;
    });
    if (moved) {
      await this.log('AGENT_COMMISSION_CANCELLED', c.agent_id, c, {
        commissionId: c.id,
        amount,
        reason,
        ...(adminId ? { adminId } : {}),
      });
      const { jobTitle } = await this.placementNames(
        c.job_offer_id,
        c.worker_id,
      );
      await this.notifications.notify(
        c.agent_id,
        { type: 'COMMISSION_CANCELLED', amount, jobTitle, reason },
        `commission:${c.id}:cancelled`,
      );
    }
    return moved;
  }

  /** Admin cancellation, with a reason (fraud, a placement found to be fake). */
  async adminCancel(
    agentId: string,
    commissionId: string,
    reason: string,
    adminId: string,
  ) {
    const c = await this.prisma.agentCommission.findFirst({
      where: { id: commissionId, agent_id: agentId },
      select: {
        id: true,
        agent_id: true,
        status: true,
        amount: true,
        job_offer_id: true,
        worker_id: true,
        contact_unlock_attempt_id: true,
      },
    });
    if (!c) throw new NotFoundException('Commission introuvable');
    if (
      c.status !== AgentCommissionStatus.PENDING &&
      c.status !== AgentCommissionStatus.AVAILABLE
    ) {
      throw new ConflictException(
        'Cette commission ne peut plus être annulée.',
      );
    }
    const moved = await this.cancel(c, c.status, reason, adminId);
    if (!moved) {
      throw new ConflictException('Cette commission vient de changer d’état.');
    }
    return this.list(agentId, { page: 1, limit: 1, id: commissionId }).then(
      (r) => r.data[0],
    );
  }

  /** What the agent's notification names: the worker and the job. */
  private async placementNames(jobOfferId: string, workerId: string) {
    const [job, worker] = await Promise.all([
      this.prisma.jobOffer.findUnique({
        where: { id: jobOfferId },
        select: { title: true },
      }),
      this.prisma.profile.findUnique({
        where: { id: workerId },
        select: { first_name: true, last_name: true },
      }),
    ]);
    return {
      jobTitle: job?.title ?? 'une offre',
      workerName: worker
        ? `${worker.first_name} ${worker.last_name}`.trim()
        : 'Le travailleur',
    };
  }

  // ── read ──────────────────────────────────────────────────────────────────

  /**
   * An agent's commissions, newest first. The agent app and the admin read
   * the same shape: the job's title and the worker's name — never the
   * employer, never a phone.
   */
  async list(
    agentId: string,
    params: {
      page: number;
      limit: number;
      status?: AgentCommissionStatus;
      id?: string;
    },
  ) {
    const where: Prisma.AgentCommissionWhereInput = {
      agent_id: agentId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.id ? { id: params.id } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.agentCommission.count({ where }),
      this.prisma.agentCommission.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
    ]);

    const [jobs, workers] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.job_offer_id))] } },
        select: { id: true, title: true, city: true },
      }),
      this.prisma.profile.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.worker_id))] } },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          avatar_url: true,
        },
      }),
    ]);
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const workerById = new Map(workers.map((w) => [w.id, w]));

    return {
      data: rows.map((r) => {
        const job = jobById.get(r.job_offer_id);
        const worker = workerById.get(r.worker_id);
        return {
          id: r.id,
          status: r.status,
          amount: Number(r.amount),
          createdAt: r.created_at,
          availableAt: r.available_at,
          releasedAt: r.released_at,
          cancelledAt: r.cancelled_at,
          reason: r.reason,
          applicationId: r.application_id,
          job: job
            ? { id: job.id, title: job.title, city: job.city }
            : { id: r.job_offer_id, title: null, city: null },
          worker: worker
            ? {
                id: worker.id,
                firstName: worker.first_name,
                lastName: worker.last_name,
                avatarUrl: worker.avatar_url,
              }
            : {
                id: r.worker_id,
                firstName: null,
                lastName: null,
                avatarUrl: null,
              },
        };
      }),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async writeLedger(
    tx: Tx,
    agentId: string,
    commissionId: string,
    moves: LedgerMove[],
  ) {
    await tx.agentLedgerEntry.createMany({
      data: moves.map((m) => ({
        agent_id: agentId,
        kind: m.kind,
        bucket: m.bucket,
        amount: m.amount,
        reference_type: 'commission',
        reference_id: commissionId,
        description: m.description ?? null,
        idempotency_key: m.key,
      })),
      // A replayed move is already there; the conditional status update
      // above is what decides whether money moves at all.
      skipDuplicates: true,
    });
  }

  private log(
    action: string,
    agentId: string,
    placement: { job_offer_id: string; worker_id: string },
    metadata: Record<string, unknown>,
  ) {
    return this.logService
      .create({
        action,
        entityType: 'Agent',
        entityId: agentId,
        metadata: {
          jobOfferId: placement.job_offer_id,
          workerId: placement.worker_id,
          ...metadata,
        },
      })
      .catch(() => undefined);
  }
}
