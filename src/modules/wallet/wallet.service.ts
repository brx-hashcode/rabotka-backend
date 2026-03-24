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
} from '@prisma/client';
import { generatePaymentReference } from '../../common/utils/payment-reference';
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

export type AdminPaymentItem = {
  id: string;
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the system wallet, creating it if it does not exist.
   */
  async getOrCreateSystemWallet(): Promise<{
    id: string;
    balance: number;
  }> {
    let wallet = await this.prisma.wallet.findFirst({
      where: {
        owner_type: WalletOwnerType.SYSTEM,
        user_id: null,
        profile_id: null,
      },
    });
    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          owner_type: WalletOwnerType.SYSTEM,
          balance: 0,
        },
      });
    }
    return {
      id: wallet.id,
      balance: Number(wallet.balance),
    };
  }

  /**
   * Records a penalty payment: creates Payment, credits system wallet, and marks penalty as paid.
   * Returns the generated RBK reference. Caller must ensure the penalty exists, belongs to the profile, and is unpaid.
   */
  async recordPenaltyPayment(
    penaltyId: string,
    profileId: string,
    dto: PayPenaltyDto,
  ): Promise<{ reference: string }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
    });
    if (!penalty || penalty.worker_id !== profileId) {
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

  /**
   * Returns system revenue (balance of the system wallet) for admin reporting.
   */
  async getSystemRevenue(): Promise<{
    totalRevenue: number;
    balance: number;
  }> {
    const wallet = await this.getOrCreateSystemWallet();
    return {
      totalRevenue: wallet.balance,
      balance: wallet.balance,
    };
  }

  async listTransactionsForAdmin(params: {
    page: number;
    limit: number;
    type?: string[];
    created_from?: string;
    created_to?: string;
  }): Promise<{ data: AdminWalletTransactionItem[]; total: number; page: number; limit: number }> {
    const { page, limit } = params;
    const where: Record<string, unknown> = {};

    if (params.type?.length) {
      where.type = { in: params.type as WalletTransactionType[] };
    }
    if (params.created_from || params.created_to) {
      where.created_at = {
        ...(params.created_from ? { gte: new Date(params.created_from) } : {}),
        ...(params.created_to ? { lte: new Date(params.created_to + 'T23:59:59.999Z') } : {}),
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
    type?: string[];
    status?: string[];
    created_from?: string;
    created_to?: string;
  }): Promise<{ data: AdminPaymentItem[]; total: number; page: number; limit: number }> {
    const { page, limit } = params;
    const where: Record<string, unknown> = {};

    if (params.type?.length) {
      where.type = { in: params.type as PaymentType[] };
    }
    if (params.status?.length) {
      where.status = { in: params.status as PaymentStatus[] };
    }
    if (params.created_from || params.created_to) {
      where.created_at = {
        ...(params.created_from ? { gte: new Date(params.created_from) } : {}),
        ...(params.created_to ? { lte: new Date(params.created_to + 'T23:59:59.999Z') } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
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
