import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BillingStatus, Prisma, PaymentMethod } from '@prisma/client';
import { WalletService } from '../wallet/wallet.service';

export type AdminPenaltyListItem = {
  id: string;
  workerName: string;
  workerEmail: string;
  workerPhone: string;
  workerAvatarUrl: string | null;
  workerId: string;
  applicationId: string;
  jobTitle: string;
  amount: number;
  reason: string | null;
  appliedAt: string;
  paidAt: string | null;
  createdAt: string;
};

export type AdminPenaltiesListResponse = {
  data: AdminPenaltyListItem[];
  total: number;
  page: number;
  limit: number;
};

export type AdminPenaltyDetailResponse = AdminPenaltyListItem & {
  jobOfferId: string;
  jobScheduledAt: string;
  jobAmount: number;
  jobAddress: string;
  jobPaymentFlow: string;
  jobStatus: string;
  applicationStatus: string;
};

@Injectable()
export class PenaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async confirmPenaltyPaymentByAdmin(
    penaltyId: string,
    adminUserId: string,
  ): Promise<AdminPenaltyDetailResponse> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
      select: { id: true, paid_at: true, worker_id: true },
    });

    if (!penalty) throw new NotFoundException('Pénalité introuvable');
    if (penalty.paid_at) throw new BadRequestException('Cette pénalité a déjà été réglée');

    await this.walletService.recordPenaltyPayment(penaltyId, penalty.worker_id, {
      paymentMethod: PaymentMethod.OTHER,
    });

    // Sync billing_status based on remaining unpaid penalties
    const unpaidCount = await this.prisma.penalty.count({
      where: { worker_id: penalty.worker_id, paid_at: null },
    });
    const newBillingStatus =
      unpaidCount === 0 ? BillingStatus.CLEAR : BillingStatus.PENDING_PAYMENT;
    await this.prisma.profile.update({
      where: { id: penalty.worker_id },
      data: { billing_status: newBillingStatus },
    });

    await this.prisma.log.create({
      data: {
        action: 'PAYMENT_CONFIRMED',
        entity_type: 'Penalty',
        entity_id: penaltyId,
        user_id: adminUserId,
        profile_id: penalty.worker_id,
        metadata: { note: 'Penalty manually confirmed by admin' },
      },
    });

    return this.getPenaltyDetailForAdmin(penaltyId);
  }

  async deletePenalty(id: string): Promise<{ success: boolean }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id },
      select: { id: true, worker_id: true, paid_at: true },
    });
    if (!penalty) throw new NotFoundException('Pénalité introuvable');

    await this.prisma.penalty.delete({ where: { id } });

    // Re-sync billing_status after deletion
    const unpaidCount = await this.prisma.penalty.count({
      where: { worker_id: penalty.worker_id, paid_at: null },
    });
    const newBillingStatus =
      unpaidCount === 0 ? BillingStatus.CLEAR : BillingStatus.PENDING_PAYMENT;
    await this.prisma.profile.update({
      where: { id: penalty.worker_id },
      data: { billing_status: newBillingStatus },
    });

    return { success: true };
  }

  async getPenaltyDetailForAdmin(
    id: string,
  ): Promise<AdminPenaltyDetailResponse> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id },
      include: {
        worker: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            avatar_url: true,
          },
        },
        application: {
          select: {
            id: true,
            status: true,
            job_offer: {
              select: {
                id: true,
                title: true,
                scheduled_at: true,
                amount: true,
                address: true,
                payment_flow: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!penalty) {
      throw new NotFoundException('Pénalité introuvable');
    }

    return {
      id: penalty.id,
      workerId: penalty.worker_id,
      workerName:
        `${penalty.worker.first_name ?? ''} ${penalty.worker.last_name ?? ''}`.trim() ||
        '—',
      workerEmail: penalty.worker.email,
      workerPhone: penalty.worker.phone,
      workerAvatarUrl: penalty.worker.avatar_url ?? null,
      applicationId: penalty.application_id,
      jobTitle: penalty.application.job_offer?.title ?? '—',
      jobOfferId: penalty.application.job_offer?.id ?? '',
      jobScheduledAt:
        penalty.application.job_offer?.scheduled_at?.toISOString() ?? '',
      jobAmount: Number(penalty.application.job_offer?.amount ?? 0),
      jobAddress: penalty.application.job_offer?.address ?? '',
      jobPaymentFlow: penalty.application.job_offer?.payment_flow ?? '',
      jobStatus: penalty.application.job_offer?.status ?? '',
      applicationStatus: penalty.application.status,
      amount: Number(penalty.amount),
      reason: penalty.reason,
      appliedAt: penalty.applied_at.toISOString(),
      paidAt: penalty.paid_at?.toISOString() ?? null,
      createdAt: penalty.created_at.toISOString(),
    };
  }

  async getPenaltiesForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    paymentStatus?: string[];
  }): Promise<AdminPenaltiesListResponse> {
    const { page, limit, q, paymentStatus } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.PenaltyWhereInput = {};

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      where.OR = [
        {
          worker: {
            first_name: { contains: searchTrimmed, mode: 'insensitive' },
          },
        },
        {
          worker: {
            last_name: { contains: searchTrimmed, mode: 'insensitive' },
          },
        },
        {
          worker: {
            phone: { contains: searchTrimmed, mode: 'insensitive' },
          },
        },
        { reason: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
    }

    if (paymentStatus && paymentStatus.length > 0) {
      const conditions: Prisma.PenaltyWhereInput[] = [];
      if (paymentStatus.includes('paid')) {
        conditions.push({ paid_at: { not: null } });
      }
      if (paymentStatus.includes('unpaid')) {
        conditions.push({ paid_at: null });
      }
      if (conditions.length === 1) {
        Object.assign(where, conditions[0]);
      } else if (conditions.length > 1) {
        where.OR = [...(where.OR ?? []), ...conditions];
      }
    }

    const [penalties, total] = await Promise.all([
      this.prisma.penalty.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          worker: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              phone: true,
              avatar_url: true,
            },
          },
          application: {
            select: {
              id: true,
              job_offer: {
                select: {
                  title: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.penalty.count({ where }),
    ]);

    const data: AdminPenaltyListItem[] = penalties.map((p) => ({
      id: p.id,
      workerId: p.worker_id,
      workerName:
        `${p.worker.first_name ?? ''} ${p.worker.last_name ?? ''}`.trim() ||
        '—',
      workerEmail: p.worker.email,
      workerPhone: p.worker.phone,
      workerAvatarUrl: p.worker.avatar_url ?? null,
      applicationId: p.application_id,
      jobTitle: p.application.job_offer?.title ?? '—',
      amount: Number(p.amount),
      reason: p.reason,
      appliedAt: p.applied_at.toISOString(),
      paidAt: p.paid_at?.toISOString() ?? null,
      createdAt: p.created_at.toISOString(),
    }));

    return { data, total, page, limit };
  }
}
