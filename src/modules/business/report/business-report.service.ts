import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  CvScreeningResumeStatus,
  InterviewStatus,
  InvoiceReason,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { htmlToPdf } from '../../../common/utils/puppeteer';
import { BusinessStatsService } from '../business-stats.service';
import type { StatsPeriod } from '../business-stats';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  buildReportHtml,
  reportFilename,
  type ReportInput,
} from './business-report';

/** Offers listed in the report: the busiest of the period. */
const MAX_OFFERS = 30;

/**
 * The dashboard's period as a PDF: its figures (BusinessStatsService), every
 * offer active in the period, the interviews, the CVs analysed, and what was
 * paid — so the business can show what recruiting on Rabotka gave.
 */
@Injectable()
export class BusinessReportService {
  private readonly logger = new Logger(BusinessReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: BusinessStatsService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  async pdf(profileId: string, days: StatsPeriod, now = new Date()) {
    const input = await this.input(profileId, days, now);
    try {
      return {
        buffer: await htmlToPdf(
          buildReportHtml(input),
          'Rapport de recrutement',
        ),
        filename: reportFilename(input),
      };
    } catch (err) {
      this.logger.error(
        'Recruitment report PDF failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException(
        'Le rapport n’a pas pu être créé. Réessayez dans un instant.',
      );
    }
  }

  async input(
    profileId: string,
    days: StatsPeriod,
    now = new Date(),
  ): Promise<ReportInput> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const stats = await this.stats.stats(profileId, days, now);
    const from = new Date(stats.period.from);
    const window = { gte: from, lte: now };

    const [business, offers, interviews, cvAnalysed, invoices] =
      await Promise.all([
        this.prisma.business.findUnique({
          where: { id: businessId },
          select: { name: true },
        }),
        this.prisma.jobOffer.findMany({
          where: {
            employer_id: profileId,
            deleted_at: null,
            OR: [
              { created_at: window },
              { applications: { some: { created_at: window } } },
              { applications: { some: { accepted_at: window } } },
            ],
          },
          select: {
            title: true,
            status: true,
            quantity: true,
            applications: {
              where: {
                deleted_at: null,
                OR: [{ created_at: window }, { accepted_at: window }],
              },
              select: { created_at: true, accepted_at: true },
            },
          },
        }),
        this.prisma.interview.groupBy({
          by: ['status'],
          where: { business_id: businessId, created_at: window },
          _count: { _all: true },
        }),
        this.prisma.cvScreeningResume.count({
          where: {
            status: CvScreeningResumeStatus.SCORED,
            created_at: window,
            screening: { business_id: businessId },
          },
        }),
        this.prisma.invoice.groupBy({
          by: ['reason'],
          where: { profile_id: profileId, created_at: window },
          _sum: { amount: true },
        }),
      ]);

    const within = (d: Date | null) => !!d && d >= from && d <= now;
    const interviewCount = (s?: InterviewStatus) =>
      interviews
        .filter((g) => !s || g.status === s)
        .reduce((n, g) => n + g._count._all, 0);
    const paid = (r: InvoiceReason) =>
      Number(invoices.find((g) => g.reason === r)?._sum.amount ?? 0);
    const total = invoices.reduce((n, g) => n + Number(g._sum.amount ?? 0), 0);
    const subscription = paid(InvoiceReason.BUSINESS_SUBSCRIPTION);
    const contacts = paid(InvoiceReason.CONTACT_UNLOCK);

    return {
      businessName: business?.name ?? '',
      stats,
      offers: offers
        .map((o) => ({
          title: o.title,
          status: o.status,
          positions: o.quantity,
          received: o.applications.filter((a) => within(a.created_at)).length,
          hired: o.applications.filter((a) => within(a.accepted_at)).length,
        }))
        .sort((a, b) => b.received - a.received || b.hired - a.hired)
        .slice(0, MAX_OFFERS),
      interviews: {
        proposed: interviewCount(),
        confirmed: interviewCount(InterviewStatus.CONFIRMED),
        declined: interviewCount(InterviewStatus.DECLINED),
      },
      cvAnalysed,
      spend: {
        total,
        subscription,
        contacts,
        other: total - subscription - contacts,
      },
      generatedAt: now,
    };
  }
}
