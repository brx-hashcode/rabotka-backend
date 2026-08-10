import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

export interface AdminFeedbackItem {
  id: string;
  createdAt: Date;
  score: number;
  comment: string | null;
  source: string;
  profile: {
    id: string;
    firstName: string;
    lastName: string;
    phone: string;
    profileType: string;
  } | null;
}

export interface FeedbackStats {
  total: number;
  average: number;
  withComment: number;
  /** Count per score 1-5, always all five keys so a chart has no gaps. */
  distribution: { score: number; count: number }[];
  /** Daily totals and average over the window, oldest first. */
  trend: { date: string; count: number; average: number }[];
  byProfileType: { profileType: string; count: number; average: number }[];
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async listForAdmin(params: {
    page?: number;
    limit?: number;
    q?: string;
    score?: number;
    withComment?: boolean;
  }): Promise<{
    data: AdminFeedbackItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;

    const where: Prisma.FeedbackWhereInput = {
      ...(params.score ? { score: params.score } : {}),
      // `not: null` alone would still match empty strings; the column is
      // nullable and a blank comment is stored as null, but be explicit.
      ...(params.withComment ? { comment: { not: null } } : {}),
      ...(params.q
        ? {
            OR: [
              { comment: { contains: params.q, mode: 'insensitive' } },
              {
                profile: {
                  OR: [
                    { first_name: { contains: params.q, mode: 'insensitive' } },
                    { last_name: { contains: params.q, mode: 'insensitive' } },
                    { phone: { contains: params.q } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.feedback.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          profile: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              profile_type: true,
            },
          },
        },
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        score: r.score,
        comment: r.comment,
        source: r.source,
        profile: r.profile
          ? {
              id: r.profile.id,
              firstName: r.profile.first_name,
              lastName: r.profile.last_name,
              phone: r.profile.phone,
              profileType: String(r.profile.profile_type),
            }
          : null,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Everything the dashboard needs, in one round trip.
   *
   * `days` bounds the trend only. The headline figures cover all time, because
   * an average that silently changes meaning with a date filter is worse than
   * no average.
   */
  async statsForAdmin(days = 30): Promise<FeedbackStats> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [grouped, commented, byType, trendRows] = await Promise.all([
      this.prisma.feedback.groupBy({ by: ['score'], _count: { _all: true } }),
      this.prisma.feedback.count({ where: { comment: { not: null } } }),
      this.prisma.$queryRaw<
        { profile_type: string; count: bigint; average: number }[]
      >`
        SELECT p."profile_type"::text AS profile_type,
               COUNT(*)              AS count,
               AVG(f."score")::float AS average
        FROM "feedback" f
        JOIN "profiles" p ON p."id" = f."profile_id"
        GROUP BY p."profile_type"
      `,
      this.prisma.$queryRaw<{ date: Date; count: bigint; average: number }[]>`
        SELECT date_trunc('day', f."created_at") AS date,
               COUNT(*)                          AS count,
               AVG(f."score")::float             AS average
        FROM "feedback" f
        WHERE f."created_at" >= ${since}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
    ]);

    const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const weighted = grouped.reduce(
      (sum, g) => sum + g.score * g._count._all,
      0,
    );

    return {
      total,
      average: total ? Number((weighted / total).toFixed(2)) : 0,
      withComment: commented,
      // Every score present even at zero — a bar chart with a missing category
      // reads as "no 2-star feedback exists" rather than "none yet".
      distribution: [1, 2, 3, 4, 5].map((score) => ({
        score,
        count: grouped.find((g) => g.score === score)?._count._all ?? 0,
      })),
      trend: trendRows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        count: Number(r.count),
        average: Number(Number(r.average).toFixed(2)),
      })),
      byProfileType: byType.map((r) => ({
        profileType: r.profile_type,
        count: Number(r.count),
        average: Number(Number(r.average).toFixed(2)),
      })),
    };
  }
}
