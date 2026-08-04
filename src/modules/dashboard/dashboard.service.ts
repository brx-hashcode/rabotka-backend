import {
  AdminCacheService,
  ADMIN_DASHBOARD_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TimeRange } from './dto/job-activity-query.dto';
import { countPaidContactPairs } from '../../common/queries/paid-contacts.sql';

export type JobActivityDataPoint = {
  date: string;
  jobCreated: number;
  jobFilled: number;
};

export type DashboardMetrics = {
  /**
   * Distinct employer↔worker pairs where the employer paid to make contact.
   * The same number the Network graph draws as a "Contact payé" edge — both
   * read `paidContactPairs()` so the card and the graph cannot disagree.
   */
  connectionsCount: number;
  connectionsTrend: number | null;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
  ) {}

  async getMetrics(): Promise<DashboardMetrics> {
    return this.cache.wrap(
      this.cache.dashboardKey('metrics'),
      ADMIN_DASHBOARD_TTL_SECONDS,
      () => this.loadMetrics(),
    );
  }

  /** Distinct paid employer↔worker pairs, optionally within a window. */
  private async countConnections(where?: {
    since?: Date;
    until?: Date;
  }): Promise<number> {
    const rows =
      await this.prisma.$queryRaw<{ count: number }[]>(
        countPaidContactPairs(where),
      );
    return rows[0]?.count ?? 0;
  }

  private async loadMetrics(): Promise<DashboardMetrics> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    const [
      connectionsTotal,
      connectionsCurrent,
      connectionsPrevious,
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
      // Connections: employers who paid to reach a worker. Counted as distinct
      // pairs, not payments — paying twice for the same worker is still one
      // relationship, which is what the graph shows.
      this.countConnections(),
      this.countConnections({ since: thirtyDaysAgo }),
      this.countConnections({ since: sixtyDaysAgo, until: thirtyDaysAgo }),
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
      connectionsCount: connectionsTotal,
      connectionsTrend: this.calcTrend(connectionsCurrent, connectionsPrevious),
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
    return this.cache.wrap(
      this.cache.dashboardKey('job-status', { range }),
      ADMIN_DASHBOARD_TTL_SECONDS,
      () => this.loadJobStatusDistribution(range),
    );
  }

  private async loadJobStatusDistribution(
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
    return this.cache.wrap(
      this.cache.dashboardKey('job-activity', { range }),
      ADMIN_DASHBOARD_TTL_SECONDS,
      () => this.loadJobActivity(range),
    );
  }

  private async loadJobActivity(
    range: TimeRange,
  ): Promise<JobActivityDataPoint[]> {
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
