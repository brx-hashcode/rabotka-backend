import { Injectable } from '@nestjs/common';
import { RatingDirection } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { computeBusinessStats, type StatsPeriod } from './business-stats';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Loads a business's recruitment rows; `computeBusinessStats` does the rest. */
@Injectable()
export class BusinessStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats(profileId: string, days: StatsPeriod, now = new Date()) {
    // The previous period too, for the trend.
    const since = new Date(now.getTime() - 2 * days * DAY_MS);
    const [offers, applications, assignments, unlocks, ratingsGiven, profile] =
      await Promise.all([
        this.prisma.jobOffer.findMany({
          where: { employer_id: profileId, deleted_at: null },
          select: {
            id: true,
            title: true,
            status: true,
            quantity: true,
            created_at: true,
            category: { select: { name: true } },
          },
        }),
        this.prisma.application.findMany({
          where: {
            deleted_at: null,
            job_offer: { employer_id: profileId, deleted_at: null },
          },
          select: {
            job_offer_id: true,
            status: true,
            created_at: true,
            viewed_at: true,
            accepted_at: true,
            rejected_at: true,
          },
        }),
        this.prisma.assignment.findMany({
          where: {
            job_offer: { employer_id: profileId },
            created_at: { gte: since },
          },
          select: { status: true, created_at: true },
        }),
        this.prisma.contactRecord.findMany({
          where: { employer_id: profileId, unlocked_at: { gte: since } },
          select: { unlocked_at: true },
        }),
        this.prisma.rating.findMany({
          where: {
            rater_id: profileId,
            direction: RatingDirection.EMPLOYER_TO_WORKER,
          },
          select: { score: true },
        }),
        this.prisma.profile.findUnique({
          where: { id: profileId },
          select: { rating_avg: true, rating_count: true },
        }),
      ]);

    return computeBusinessStats({
      now,
      days,
      offers,
      applications,
      assignments,
      unlocks: unlocks.map((u) => u.unlocked_at),
      ratingsGiven: ratingsGiven.map((r) => r.score),
      ratingReceived: {
        avg: profile?.rating_avg ?? null,
        count: profile?.rating_count ?? 0,
      },
    });
  }
}
