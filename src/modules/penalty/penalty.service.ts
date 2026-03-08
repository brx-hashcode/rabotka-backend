import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { Prisma } from '@prisma/client';

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

@Injectable()
export class PenaltyService {
  constructor(private readonly prisma: PrismaService) {}

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
