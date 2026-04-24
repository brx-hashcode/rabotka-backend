import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  WalletOwnerType,
  WalletTransactionType,
  PaymentStatus,
  PaymentType,
  PaymentMethod,
  ProfileType,
} from '@prisma/client';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { SystemConfigService } from '../system-config/system-config.service';
import type { PayPenaltyDto } from './dto/pay-penalty.dto';

export type AdminWalletTransactionItem = {
  id: string;
  walletId: string;
  type: string;
  amount: number;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
};

export type AdminProfileWallet = {
  balance: number;
  transactions: AdminWalletTransactionItem[];
};

export type AdminPaymentItem = {
  id: string;
  profileId: string;
  type: string;
  amount: number;
  paymentMethod: string;
  transactionId: string;
  status: string;
  paidAt: string | null;
  description: string | null;
  profileName: string | null;
  profileEmail: string | null;
  createdAt: string;
};

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async getOrCreateSystemWallet(): Promise<{
    id: string;
    balance: number;
  }> {
    // Use raw INSERT ON CONFLICT DO NOTHING to avoid race on singleton system wallet
    await this.prisma.$queryRaw`
      INSERT INTO wallets (id, owner_type, balance, created_at, updated_at)
      VALUES (gen_random_uuid(), 'SYSTEM', 0, now(), now())
      ON CONFLICT DO NOTHING
    `;
    const wallet = await this.prisma.wallet.findFirstOrThrow({
      where: { owner_type: WalletOwnerType.SYSTEM, user_id: null, profile_id: null },
    });
    return { id: wallet.id, balance: Number(wallet.balance) };
  }

  async getOrCreateProfileWallet(
    profileId: string,
  ): Promise<{ id: string; balance: number }> {
    const wallet = await this.prisma.wallet.upsert({
      where: { idx_wallet_owner_profile: { owner_type: WalletOwnerType.PROFILE, profile_id: profileId } },
      update: {},
      create: { owner_type: WalletOwnerType.PROFILE, profile_id: profileId, balance: 0 },
    });
    return { id: wallet.id, balance: Number(wallet.balance) };
  }

  async getProfileWalletBalance(profileId: string): Promise<number> {
    const w = await this.getOrCreateProfileWallet(profileId);
    return w.balance;
  }

  async getProfileWalletForAdmin(
    profileId: string,
  ): Promise<AdminProfileWallet> {
    const wallet = await this.getOrCreateProfileWallet(profileId);
    const txs = await this.prisma.walletTransaction.findMany({
      where: { wallet_id: wallet.id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      balance: wallet.balance,
      transactions: txs.map((t) => ({
        id: t.id,
        walletId: t.wallet_id,
        type: t.type,
        amount: Number(t.amount),
        referenceType: t.reference_type ?? null,
        referenceId: t.reference_id ?? null,
        createdAt: t.created_at.toISOString(),
      })),
    };
  }

  async creditProfileWallet(
    profileId: string,
    amount: number,
    type: WalletTransactionType,
    referenceType?: string,
    referenceId?: string,
  ): Promise<void> {
    const wallet = await this.getOrCreateProfileWallet(profileId);
    await this.prisma.$transaction(async (tx) => {
      await tx.walletTransaction.create({
        data: {
          wallet_id: wallet.id,
          type,
          amount,
          reference_type: referenceType ?? null,
          reference_id: referenceId ?? null,
        },
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });
    });
  }

  async debitProfileWallet(
    profileId: string,
    amount: number,
    type: WalletTransactionType,
    referenceType?: string,
    referenceId?: string,
  ): Promise<void> {
    const wallet = await this.getOrCreateProfileWallet(profileId);
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (updated.count === 0) {
        throw new BadRequestException(
          'Solde insuffisant dans votre portefeuille',
        );
      }
      await tx.walletTransaction.create({
        data: {
          wallet_id: wallet.id,
          type,
          amount,
          reference_type: referenceType ?? null,
          reference_id: referenceId ?? null,
        },
      });
    });
  }

  async debitProfileAndCreditSystem(
    profileId: string,
    amount: number,
    debitType: WalletTransactionType,
    creditType: WalletTransactionType,
    referenceType: string,
    referenceId: string,
  ): Promise<void> {
    const profileWallet = await this.getOrCreateProfileWallet(profileId);
    const systemWallet = await this.getOrCreateSystemWallet();

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.wallet.updateMany({
        where: { id: profileWallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Solde insuffisant dans votre portefeuille');
      }
      await tx.walletTransaction.create({
        data: {
          wallet_id: profileWallet.id,
          type: debitType,
          amount,
          reference_type: referenceType,
          reference_id: referenceId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: amount } },
      });
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: creditType,
          amount,
          reference_type: referenceType,
          reference_id: referenceId,
        },
      });
    });
  }

  async grantWelcomeCredit(
    profileId: string,
    profileType: ProfileType,
  ): Promise<number> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { whatsapp_activation_bonus_granted: true },
    });
    if (!profile) throw new NotFoundException('Profil introuvable');
    if (profile.whatsapp_activation_bonus_granted) return 0;

    const credits = await this.systemConfig.getWelcomeCredits();
    const amount =
      profileType === ProfileType.WORKER
        ? credits.workerCreditFcfa
        : credits.employerCreditFcfa;

    const wallet = await this.getOrCreateProfileWallet(profileId);

    await this.prisma.$transaction(async (tx) => {
      await tx.walletTransaction.create({
        data: {
          wallet_id: wallet.id,
          type: WalletTransactionType.WELCOME_CREDIT,
          amount,
          reference_type: 'profile',
          reference_id: profileId,
        },
      });
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });
      await tx.profile.update({
        where: { id: profileId },
        data: { whatsapp_activation_bonus_granted: true },
      });
    });

    return amount;
  }

  async payPenaltyFromWallet(
    penaltyId: string,
    profileId: string,
  ): Promise<{ reference: string }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (penalty?.worker_id !== profileId) {
      throw new NotFoundException('Pénalité introuvable');
    }

    const [profileWallet, systemWallet] = await Promise.all([
      this.getOrCreateProfileWallet(profileId),
      this.getOrCreateSystemWallet(),
    ]);
    const reference = generatePaymentReference();

    await this.prisma.$transaction(async (tx) => {
      // Atomic idempotency guard + balance check: only proceeds if penalty unpaid and balance sufficient
      const [penaltyUpdate, walletUpdate] = await Promise.all([
        tx.penalty.updateMany({
          where: { id: penaltyId, paid_at: null },
          data: { paid_at: new Date() },
        }),
        tx.wallet.updateMany({
          where: { id: profileWallet.id, balance: { gte: penalty.amount } },
          data: { balance: { decrement: penalty.amount } },
        }),
      ]);
      if (penaltyUpdate.count === 0) {
        throw new BadRequestException('Cette pénalité a déjà été réglée');
      }
      if (walletUpdate.count === 0) {
        throw new BadRequestException('Solde insuffisant pour régler cette pénalité');
      }
      await tx.walletTransaction.create({
        data: {
          wallet_id: profileWallet.id,
          type: WalletTransactionType.PENALTY_DEBIT,
          amount: penalty.amount,
          reference_type: 'penalty',
          reference_id: penaltyId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: penalty.amount } },
      });
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CREDIT_PENALTY,
          amount: penalty.amount,
          reference_type: 'penalty',
          reference_id: penaltyId,
        },
      });
      await tx.payment.create({
        data: {
          type: PaymentType.PENALTY,
          profile_id: profileId,
          amount: penalty.amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: reference,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Penalty ${penaltyId} paid via wallet`,
        },
      });
    });

    return { reference };
  }

  async recordPenaltyPayment(
    penaltyId: string,
    profileId: string,
    dto: PayPenaltyDto,
  ): Promise<{ reference: string }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (penalty?.worker_id !== profileId) {
      throw new NotFoundException('Pénalité introuvable');
    }
    if (penalty.paid_at) {
      throw new BadRequestException('Cette pénalité a déjà été réglée');
    }

    const systemWallet = await this.getOrCreateSystemWallet();
    const reference = generatePaymentReference();

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          type: PaymentType.PENALTY,
          profile_id: profileId,
          amount: penalty.amount,
          payment_method: dto.paymentMethod,
          transaction_id: reference,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Penalty payment for penalty ${penaltyId}`,
        },
      });
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CREDIT_PENALTY,
          amount: penalty.amount,
          reference_type: 'penalty',
          reference_id: penaltyId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: {
          balance: { increment: penalty.amount },
        },
      });
      await tx.penalty.update({
        where: { id: penaltyId },
        data: { paid_at: new Date() },
      });
    });

    return { reference };
  }

  async recordRegistrationPayment(
    profileId: string,
    amount: number,
  ): Promise<void> {
    const wallet = await this.getOrCreateSystemWallet();
    const transactionId = generatePaymentReference();
    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          type: PaymentType.REGISTRATION,
          profile_id: profileId,
          amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: transactionId,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Account registration payment for profile ${profileId}`,
        },
      }),
      this.prisma.walletTransaction.create({
        data: {
          wallet_id: wallet.id,
          type: WalletTransactionType.CREDIT_REGISTRATION,
          amount,
          reference_type: 'profile',
          reference_id: profileId,
        },
      }),
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      }),
    ]);
  }

  async recordJobPostingPayment(
    jobOfferId: string,
    employerId: string,
    amount: number,
  ): Promise<void> {
    const wallet = await this.getOrCreateSystemWallet();
    const transactionId = generatePaymentReference();
    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          type: PaymentType.JOB_POSTING,
          profile_id: employerId,
          amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: transactionId,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Job posting fee for job offer ${jobOfferId}`,
        },
      }),
      this.prisma.walletTransaction.create({
        data: {
          wallet_id: wallet.id,
          type: WalletTransactionType.CREDIT_JOB_POSTING,
          amount,
          reference_type: 'job_offer',
          reference_id: jobOfferId,
        },
      }),
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      }),
    ]);
  }

  async getSystemRevenue(): Promise<{
    totalRevenue: number;
    balance: number;
    completedCount: number;
    pendingCount: number;
    failedCount: number;
    revenueByType: { penalty: number; contactUnlock: number };
  }> {
    const systemWallet = await this.getOrCreateSystemWallet();

    const [
      completedAgg,
      pendingCount,
      failedCount,
      penaltyAgg,
      contactUnlockPaymentAgg,
      contactUnlockWalletAgg,
    ] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.COMPLETED },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.payment.count({ where: { status: PaymentStatus.PENDING } }),
      this.prisma.payment.count({ where: { status: PaymentStatus.FAILED } }),
      this.prisma.payment.aggregate({
        where: { status: PaymentStatus.COMPLETED, type: PaymentType.PENALTY },
        _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          status: PaymentStatus.COMPLETED,
          type: PaymentType.CONTACT_UNLOCK,
        },
        _sum: { amount: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
        },
        _sum: { amount: true },
      }),
    ]);

    const totalRevenue = Number(systemWallet.balance);

    return {
      totalRevenue,
      balance: totalRevenue,
      completedCount: completedAgg._count,
      pendingCount,
      failedCount,
      revenueByType: {
        penalty: Number(penaltyAgg._sum.amount ?? 0),
        contactUnlock:
          Number(contactUnlockPaymentAgg._sum.amount ?? 0) +
          Number(contactUnlockWalletAgg._sum.amount ?? 0),
      },
    };
  }

  /**
   * Revenue aggregated by calendar month for January–December of `year`
   * (missing months still returned with revenue 0).
   */
  async getMonthlyRevenueForCalendarYear(
    year: number,
  ): Promise<{ month: string; revenue: number }[]> {
    const y = Math.min(2100, Math.max(2000, Math.floor(year)));

    const rows = await this.prisma.$queryRaw<
      { month: Date; revenue: bigint }[]
    >`
      SELECT
        d.month::date AS month,
        COALESCE(SUM(p.amount), 0)::bigint AS revenue
      FROM generate_series(
        DATE_TRUNC('month', make_date(${y}, 1, 1)),
        DATE_TRUNC('month', make_date(${y}, 12, 1)),
        '1 month'::interval
      ) AS d(month)
      LEFT JOIN "payments" p
        ON DATE_TRUNC('month', p.paid_at) = d.month
        AND p.status = 'COMPLETED'
      GROUP BY d.month
      ORDER BY d.month ASC
    `;

    return rows.map((row) => ({
      month: new Date(row.month).toISOString().slice(0, 7),
      revenue: Number(row.revenue),
    }));
  }

  /**
   * Last `months` calendar months ending at the current month (e.g. months=6 in
   * April → Nov … Apr), for rolling dashboards like the revenue radar.
   */
  async getMonthlyRevenueRollingMonths(
    months: number,
  ): Promise<{ month: string; revenue: number }[]> {
    const clampedMonths = Math.min(Math.max(1, months), 24);
    const span = clampedMonths - 1;

    const rows = await this.prisma.$queryRaw<
      { month: Date; revenue: bigint }[]
    >`
      SELECT
        d.month::date AS month,
        COALESCE(SUM(p.amount), 0)::bigint AS revenue
      FROM generate_series(
        DATE_TRUNC('month', NOW() - (${span} * INTERVAL '1 month')),
        DATE_TRUNC('month', NOW()),
        INTERVAL '1 month'
      ) AS d(month)
      LEFT JOIN "payments" p
        ON DATE_TRUNC('month', p.paid_at) = d.month
        AND p.status = 'COMPLETED'
      GROUP BY d.month
      ORDER BY d.month ASC
    `;

    return rows.map((row) => ({
      month: new Date(row.month).toISOString().slice(0, 7),
      revenue: Number(row.revenue),
    }));
  }

  async listTransactionsForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    type?: string[];
    created_from?: string;
    created_to?: string;
  }): Promise<{
    data: AdminWalletTransactionItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit } = params;
    const systemWallet = await this.getOrCreateSystemWallet();
    // Only show system wallet transactions — profile debits are internal and irrelevant here
    const where: Record<string, unknown> = { wallet_id: systemWallet.id };

    if (params.q) {
      where.OR = [
        { type: { contains: params.q, mode: 'insensitive' } },
        { reference_type: { contains: params.q, mode: 'insensitive' } },
        { reference_id: { contains: params.q, mode: 'insensitive' } },
        {
          wallet: {
            profile: {
              OR: [
                { first_name: { contains: params.q, mode: 'insensitive' } },
                { last_name: { contains: params.q, mode: 'insensitive' } },
                { email: { contains: params.q, mode: 'insensitive' } },
                { phone: { contains: params.q, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }
    if (params.type?.length) {
      where.type = { in: params.type as WalletTransactionType[] };
    }
    if (params.created_from || params.created_to) {
      where.created_at = {
        ...(params.created_from ? { gte: new Date(params.created_from) } : {}),
        ...(params.created_to
          ? { lte: new Date(params.created_to + 'T23:59:59.999Z') }
          : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        select: {
          id: true,
          wallet_id: true,
          type: true,
          amount: true,
          reference_type: true,
          reference_id: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        walletId: r.wallet_id,
        type: r.type,
        amount: Number(r.amount),
        referenceType: r.reference_type ?? null,
        referenceId: r.reference_id ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  async listPaymentsForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    type?: string[];
    status?: string[];
    created_from?: string;
    created_to?: string;
  }): Promise<{
    data: AdminPaymentItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit } = params;
    const where: Record<string, unknown> = {};

    if (params.q) {
      const orClauses: unknown[] = [
        { transaction_id: { contains: params.q, mode: 'insensitive' } },
        { description: { contains: params.q, mode: 'insensitive' } },
        {
          profile: {
            OR: [
              { first_name: { contains: params.q, mode: 'insensitive' } },
              { last_name: { contains: params.q, mode: 'insensitive' } },
              { email: { contains: params.q, mode: 'insensitive' } },
            ],
          },
        },
      ];

      // Support searching by invoice reference (RBT-YYYY-XXXXXXXX)
      const invoiceRefMatch = params.q
        .trim()
        .toUpperCase()
        .match(/^RBT-\d{4}-([0-9A-F]{8})$/);
      if (invoiceRefMatch) {
        const shortHex = invoiceRefMatch[1].toLowerCase();
        const matchingInvoices = await this.prisma.$queryRaw<
          { id: string; payment_request_id: string }[]
        >`SELECT id, payment_request_id FROM invoices WHERE id::text LIKE ${shortHex + '%'}`;
        const filtered = matchingInvoices.filter(
          (inv) =>
            inv.id.replaceAll('-', '').slice(0, 8).toLowerCase() === shortHex,
        );
        if (filtered.length > 0) {
          const paymentRequestIds = filtered.map(
            (inv) => inv.payment_request_id,
          );
          const paymentRequests = await this.prisma.paymentRequest.findMany({
            where: { id: { in: paymentRequestIds } },
            select: { profile_id: true, amount: true },
          });
          for (const pr of paymentRequests) {
            orClauses.push({
              AND: [
                { profile_id: pr.profile_id },
                { amount: pr.amount },
                { status: 'COMPLETED' },
              ],
            });
          }
        }
      }

      where.OR = orClauses;
    }
    if (params.type?.length) {
      where.type = { in: params.type as PaymentType[] };
    }
    if (params.status?.length) {
      where.status = { in: params.status as PaymentStatus[] };
    }
    if (params.created_from || params.created_to) {
      where.created_at = {
        ...(params.created_from ? { gte: new Date(params.created_from) } : {}),
        ...(params.created_to
          ? { lte: new Date(params.created_to + 'T23:59:59.999Z') }
          : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
          profile_id: true,
          type: true,
          amount: true,
          payment_method: true,
          transaction_id: true,
          status: true,
          paid_at: true,
          description: true,
          created_at: true,
          profile: {
            select: { first_name: true, last_name: true, email: true },
          },
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        profileId: r.profile_id,
        type: r.type,
        amount: Number(r.amount),
        paymentMethod: r.payment_method,
        transactionId: r.transaction_id,
        status: r.status,
        paidAt: r.paid_at ? r.paid_at.toISOString() : null,
        description: r.description ?? null,
        profileName: r.profile
          ? `${r.profile.first_name} ${r.profile.last_name}`.trim()
          : null,
        profileEmail: r.profile?.email ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }
}
