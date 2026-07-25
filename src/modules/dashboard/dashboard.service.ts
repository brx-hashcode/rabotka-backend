import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TimeRange } from './dto/job-activity-query.dto';

export type JobActivityDataPoint = {
  date: string;
  jobCreated: number;
  jobFilled: number;
};

export type DashboardMetrics = {
  assignmentsCount: number;
  assignmentsTrend: number | null;
  profilesCount: number;
  profilesTrend: number | null;
  jobsCount: number;
  jobsTrend: number | null;
  applicationsCount: number;
  applicationsTrend: number | null;
};

const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  [TimeRange.NINETY_DAYS]: 90,
  [TimeRange.THIRTY_DAYS]: 30,
  [TimeRange.SEVEN_DAYS]: 7,
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(): Promise<DashboardMetrics> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const [
      assignmentsTotal,
      assignmentsCurrent,
      assignmentsPrevious,
      profilesTotal,
      profilesCurrent,
      profilesPrevious,
      jobsTotal,
      jobsCurrent,
      jobsPrevious,
      applicationsTotal,
      applicationsCurrent,
      applicationsPrevious,
    ] = await Promise.all([
      // Total assignments (placements made)
      this.prisma.assignment.count(),
      // Assignments last 30 days
      this.prisma.assignment.count({
        where: { created_at: { gte: thirtyDaysAgo } },
      }),
      // Assignments previous 30 days
      this.prisma.assignment.count({
        where: { created_at: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } },
      }),
      // deleted_at: null everywhere below so archived (soft-deleted) rows stop
      // inflating the dashboard totals once they're bulk-deleted.
      this.prisma.profile.count({ where: { deleted_at: null } }),
      this.prisma.profile.count({
        where: { deleted_at: null, created_at: { gte: thirtyDaysAgo } },
      }),
      this.prisma.profile.count({
        where: {
          deleted_at: null,
          created_at: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        },
      }),
      this.prisma.jobOffer.count({ where: { deleted_at: null } }),
      this.prisma.jobOffer.count({
        where: { deleted_at: null, created_at: { gte: thirtyDaysAgo } },
      }),
      this.prisma.jobOffer.count({
        where: {
          deleted_at: null,
          created_at: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        },
      }),
      this.prisma.application.count({ where: { deleted_at: null } }),
      this.prisma.application.count({
        where: { deleted_at: null, created_at: { gte: thirtyDaysAgo } },
      }),
      this.prisma.application.count({
        where: {
          deleted_at: null,
          created_at: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
        },
      }),
    ]);

    return {
      assignmentsCount: assignmentsTotal,
      assignmentsTrend: this.calcTrend(assignmentsCurrent, assignmentsPrevious),
      profilesCount: profilesTotal,
      profilesTrend: this.calcTrend(profilesCurrent, profilesPrevious),
      jobsCount: jobsTotal,
      jobsTrend: this.calcTrend(jobsCurrent, jobsPrevious),
      applicationsCount: applicationsTotal,
      applicationsTrend: this.calcTrend(
        applicationsCurrent,
        applicationsPrevious,
      ),
    };
  }

  async getJobStatusDistribution(
    range: TimeRange,
  ): Promise<{ status: string; count: number }[]> {
    const days = TIME_RANGE_DAYS[range];
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() - days);

    const groups = await this.prisma.jobOffer.groupBy({
      by: ['status'],
      where: { deleted_at: null, created_at: { gte: startDate } },
      _count: { status: true },
    });

    return groups.map((g) => ({ status: g.status, count: g._count.status }));
  }

  private calcTrend(current: number, previous: number): number | null {
    if (previous === 0) return current > 0 ? 100 : null;
    const trend = Math.round(((current - previous) / previous) * 1000) / 10;
    return Math.max(-100, Math.min(trend, 100));
  }

  async getJobActivity(range: TimeRange): Promise<JobActivityDataPoint[]> {
    const days = TIME_RANGE_DAYS[range];
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() - days);

    const rows = await this.prisma.$queryRaw<
      { date: Date; job_created: bigint; job_filled: bigint }[]
    >`
      SELECT
        d.date::date AS date,
        COALESCE(created.cnt, 0) AS job_created,
        COALESCE(filled.cnt, 0) AS job_filled
      FROM generate_series(
        ${startDate}::date,
        CURRENT_DATE,
        '1 day'::interval
      ) AS d(date)
      LEFT JOIN (
        SELECT created_at::date AS day, COUNT(*) AS cnt
        FROM "job_offers"
        WHERE created_at >= ${startDate}
          AND deleted_at IS NULL
        GROUP BY created_at::date
      ) AS created ON created.day = d.date
      LEFT JOIN (
        SELECT updated_at::date AS day, COUNT(*) AS cnt
        FROM "job_offers"
        WHERE status = 'FILLED'
          AND updated_at >= ${startDate}
          AND deleted_at IS NULL
        GROUP BY updated_at::date
      ) AS filled ON filled.day = d.date
      ORDER BY d.date
    `;

    return rows.map((row) => ({
      date: new Date(row.date).toISOString().split('T')[0],
      jobCreated: Number(row.job_created),
      jobFilled: Number(row.job_filled),
    }));
  }
}
