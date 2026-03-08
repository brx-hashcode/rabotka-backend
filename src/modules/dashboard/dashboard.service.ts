import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TimeRange } from './dto/job-activity-query.dto';

export type JobActivityDataPoint = {
  date: string;
  jobCreated: number;
  jobFilled: number;
};

const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  [TimeRange.NINETY_DAYS]: 90,
  [TimeRange.THIRTY_DAYS]: 30,
  [TimeRange.SEVEN_DAYS]: 7,
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

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
        GROUP BY created_at::date
      ) AS created ON created.day = d.date
      LEFT JOIN (
        SELECT updated_at::date AS day, COUNT(*) AS cnt
        FROM "job_offers"
        WHERE status = 'FILLED'
          AND updated_at >= ${startDate}
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
