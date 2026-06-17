import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BillingStatus, Prisma, PaymentMethod } from '@prisma/client';
import { WalletService } from '../wallet/wallet.service';

export type AdminPenaltyListItem = {
  id: string;
  profileName: string;
  profileEmail: string;
  profilePhone: string;
  profileAvatarUrl: string | null;
  profileId: string;
  applicationId: string | null;
  jobTitle: string | null;
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
  jobOfferId: string | null;
  jobScheduledAt: string | null;
  jobAmount: number | null;
  jobAddress: string | null;
  jobPaymentFlow: string | null;
  jobStatus: string | null;
  applicationStatus: string | null;
};

@Injectable()
export class PenaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async createPenaltyByAdmin(params: {
    profileId: string;
    applicationId?: string | null;
    amount: number;
    reason: string;
    adminUserId: string;
  }): Promise<AdminPenaltyDetailResponse> {
    const { profileId, applicationId, amount, reason, adminUserId } = params;

    if (applicationId) {
      const application = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          id: true,
          worker_id: true,
          job_offer: { select: { employer_id: true } },
        },
      });
      if (!application) throw new NotFoundException('Candidature introuvable');
      const isWorker = application.worker_id === profileId;
      const isEmployer = application.job_offer?.employer_id === profileId;
      if (!isWorker && !isEmployer)
        throw new BadRequestException(
          "Cette candidature n'est pas associée à ce profil",
        );

      const existing = await this.prisma.penalty.findFirst({
        where: { application_id: applicationId },
        select: { id: true },
      });
      if (existing)
        throw new ConflictException(
          'Une pénalité existe déjà pour cette candidature',
        );
    }

    const penalty = await this.prisma.penalty.create({
      data: {
        profile_id: profileId,
        ...(applicationId ? { application_id: applicationId } : {}),
        amount,
        reason,
        applied_at: new Date(),
      },
    });

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { billing_status: BillingStatus.PENDING_PAYMENT },
    });

    await this.prisma.log.create({
      data: {
        action: 'PENALTY_CREATED',
        entity_type: 'Penalty',
        entity_id: penalty.id,
        user_id: adminUserId,
        profile_id: profileId,
        metadata: { amount, reason, note: 'Penalty manually created by admin' },
      },
    });

    return this.getPenaltyDetailForAdmin(penalty.id);
  }

  async confirmPenaltyPaymentByAdmin(
    penaltyId: string,
    adminUserId: string,
  ): Promise<AdminPenaltyDetailResponse> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id: penaltyId },
      select: { id: true, paid_at: true, profile_id: true },
    });

    if (!penalty) throw new NotFoundException('Pénalité introuvable');
    if (penalty.paid_at)
      throw new BadRequestException('Cette pénalité a déjà été réglée');

    await this.walletService.recordPenaltyPayment(
      penaltyId,
      penalty.profile_id,
      { paymentMethod: PaymentMethod.OTHER },
    );

    const unpaidCount = await this.prisma.penalty.count({
      where: { profile_id: penalty.profile_id, paid_at: null },
    });
    const newBillingStatus =
      unpaidCount === 0 ? BillingStatus.CLEAR : BillingStatus.PENDING_PAYMENT;
    await this.prisma.profile.update({
      where: { id: penalty.profile_id },
      data: { billing_status: newBillingStatus },
    });

    await this.prisma.log.create({
      data: {
        action: 'PAYMENT_CONFIRMED',
        entity_type: 'Penalty',
        entity_id: penaltyId,
        user_id: adminUserId,
        profile_id: penalty.profile_id,
        metadata: { note: 'Penalty manually confirmed by admin' },
      },
    });

    return this.getPenaltyDetailForAdmin(penaltyId);
  }

  async deletePenalty(id: string): Promise<{ success: boolean }> {
    const penalty = await this.prisma.penalty.findUnique({
      where: { id },
      select: { id: true, profile_id: true, paid_at: true },
    });
    if (!penalty) throw new NotFoundException('Pénalité introuvable');
    if (penalty.paid_at) {
      throw new BadRequestException(
        'Impossible de supprimer une pénalité déjà réglée',
      );
    }

    await this.prisma.penalty.delete({ where: { id } });

    const unpaidCount = await this.prisma.penalty.count({
      where: { profile_id: penalty.profile_id, paid_at: null },
    });
    const newBillingStatus =
      unpaidCount === 0 ? BillingStatus.CLEAR : BillingStatus.PENDING_PAYMENT;
    await this.prisma.profile.update({
      where: { id: penalty.profile_id },
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
        profile: {
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

    if (!penalty) throw new NotFoundException('Pénalité introuvable');

    return {
      id: penalty.id,
      profileId: penalty.profile_id,
      profileName:
        `${penalty.profile.first_name ?? ''} ${penalty.profile.last_name ?? ''}`.trim() ||
        '—',
      profileEmail: penalty.profile.email,
      profilePhone: penalty.profile.phone,
      profileAvatarUrl: penalty.profile.avatar_url ?? null,
      applicationId: penalty.application_id,
      jobTitle: penalty.application?.job_offer?.title ?? null,
      jobOfferId: penalty.application?.job_offer?.id ?? null,
      jobScheduledAt:
        penalty.application?.job_offer?.scheduled_at?.toISOString() ?? null,
      jobAmount:
        penalty.application?.job_offer?.amount != null
          ? Number(penalty.application.job_offer.amount)
          : null,
      jobAddress: penalty.application?.job_offer?.address ?? null,
      jobPaymentFlow: penalty.application?.job_offer?.payment_flow ?? null,
      jobStatus: penalty.application?.job_offer?.status ?? null,
      applicationStatus: penalty.application?.status ?? null,
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
      const parts = searchTrimmed.split(/\s+/).filter(Boolean);
      const orClauses: Prisma.PenaltyWhereInput[] = [
        { profile: { first_name: { contains: searchTrimmed, mode: 'insensitive' } } },
        { profile: { last_name: { contains: searchTrimmed, mode: 'insensitive' } } },
        { profile: { phone: { contains: searchTrimmed, mode: 'insensitive' } } },
        { reason: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
      if (parts.length >= 2) {
        orClauses.push(
          {
            AND: [
              { profile: { first_name: { contains: parts[0], mode: 'insensitive' } } },
              { profile: { last_name: { contains: parts.slice(1).join(' '), mode: 'insensitive' } } },
            ],
          },
          {
            AND: [
              { profile: { first_name: { contains: parts.slice(1).join(' '), mode: 'insensitive' } } },
              { profile: { last_name: { contains: parts[0], mode: 'insensitive' } } },
            ],
          },
        );
      }
      where.OR = orClauses;
    }

    if (paymentStatus && paymentStatus.length > 0) {
      const conditions: Prisma.PenaltyWhereInput[] = [];
      if (paymentStatus.includes('paid'))
        conditions.push({ paid_at: { not: null } });
      if (paymentStatus.includes('unpaid')) conditions.push({ paid_at: null });
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
          profile: {
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
              job_offer: { select: { title: true } },
            },
          },
        },
      }),
      this.prisma.penalty.count({ where }),
    ]);

    const data: AdminPenaltyListItem[] = penalties.map((p) => ({
      id: p.id,
      profileId: p.profile_id,
      profileName:
        `${p.profile.first_name ?? ''} ${p.profile.last_name ?? ''}`.trim() ||
        '—',
      profileEmail: p.profile.email,
      profilePhone: p.profile.phone,
      profileAvatarUrl: p.profile.avatar_url ?? null,
      applicationId: p.application_id,
      jobTitle: p.application?.job_offer?.title ?? null,
      amount: Number(p.amount),
      reason: p.reason,
      appliedAt: p.applied_at.toISOString(),
      paidAt: p.paid_at?.toISOString() ?? null,
      createdAt: p.created_at.toISOString(),
    }));

    return { data, total, page, limit };
  }
}
