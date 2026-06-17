import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { WalletService } from '../../wallet/wallet.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import type { BotProfile } from '../types/bot-state.types';
import { translateJobOfferStatus } from '../utils/status.utils';
import {
  formatOfferListCompact,
  formatOfferDetail,
  formatNoOffersAvailable,
  type OfferListItem,
} from '../messages/offers.messages';
import {
  formatMyApplicationsList,
  formatMyApplicationsListPage,
  formatCandidaturesListPage,
  formatFilledJobsListPage,
  type ApplicationForList,
  type CandidatureListItem,
  type FilledJobListItem,
} from '../messages/application.messages';
import { WORKER_ACTIVE_APPLICATION_STATUSES } from '../../application/application.service';
import {
  formatPenaltyHistory,
  formatHistoryMessage,
  formatProfileStats,
  formatEmployerProfileStats,
  type PenaltyItem,
  type CompletedMissionItem,
} from '../messages/penalty.messages';
import { ApplicationStatus, JobOfferStatus } from '@prisma/client';

const LIST_PAGE_SIZE = 5;

@Injectable()
export class BotCommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobOfferService: JobOfferService,
    private readonly applicationService: ApplicationService,
    private readonly walletService: WalletService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  async listOffers(
    profile: BotProfile,
    pageCursor?: string,
  ): Promise<{
    message: string;
    offerIds?: string[];
    nextCursor?: string | null;
  }> {
    const [workerRow, workerCategoryIds] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: profile.id },
        select: { latitude: true, longitude: true },
      }),
      this.jobOfferService.getWorkerTopCategories(profile.id),
    ]);
    const workerCoords =
      workerRow?.latitude != null && workerRow.longitude != null
        ? { lat: workerRow.latitude, lng: workerRow.longitude }
        : null;

    const { data, nextCursor } = await this.jobOfferService.findActive(
      LIST_PAGE_SIZE,
      pageCursor,
      profile.id,
      workerCoords,
      workerCategoryIds,
    );
    if (data.length === 0) {
      return { message: formatNoOffersAvailable() };
    }
    const offers: OfferListItem[] = data.map((o) => ({
      id: o.id,
      reference: o.reference,
      title: o.title,
      description: o.description,
      scheduled_at: o.scheduled_at,
      amount: o.amount,
      payment_flow: o.payment_flow,
      address: o.address,
      note: o.note,
      quantity: o.quantity,
      acceptedCount: o.acceptedCount,
      status: o.status,
    }));
    const hasMore = !!nextCursor;
    const message = formatOfferListCompact(offers, hasMore, 0);
    return {
      message,
      offerIds: data.map((o) => o.id),
      nextCursor: nextCursor ?? undefined,
    };
  }

  async getOfferDetail(offerId: string): Promise<string | null> {
    const offer = await this.jobOfferService.findById(offerId);
    if (!offer) return null;
    return formatOfferDetail({
      id: offer.id,
      reference: offer.reference,
      title: offer.title,
      description: offer.description,
      scheduled_at: offer.scheduled_at,
      amount: offer.amount,
      payment_flow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      status: offer.status,
    });
  }

  /**
   * Active candidatures only (PENDING / ACCEPTED / WAITING_PAYMENT),
   * sorted most-recent first, paginated 5 per page to fit in a single
   * WhatsApp message.
   */
  async myApplications(
    profile: BotProfile,
    page = 0,
  ): Promise<{
    message: string;
    applicationIds: string[];
    page: number;
    totalPages: number;
  }> {
    return this.fetchApplicationsPage(profile, {
      page,
      title: 'Mes candidatures',
      statusIn: WORKER_ACTIVE_APPLICATION_STATUSES,
      emptyMessage: formatMyApplicationsList([]),
    });
  }

  async pendingPayments(
    profile: BotProfile,
    page = 0,
  ): Promise<{
    message: string;
    applicationIds: string[];
    page: number;
    totalPages: number;
  }> {
    return this.fetchApplicationsPage(profile, {
      page,
      title: 'Paiements en attente',
      status: ApplicationStatus.WAITING_PAYMENT,
      emptyMessage:
        '✅ *Aucun paiement en attente* pour le moment.\n\nTapez *Menu* pour revenir.',
    });
  }

  private async fetchApplicationsPage(
    profile: BotProfile,
    opts: {
      page: number;
      title: string;
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      emptyMessage: string;
    },
  ): Promise<{
    message: string;
    applicationIds: string[];
    page: number;
    totalPages: number;
  }> {
    const filter = {
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.statusIn ? { statusIn: opts.statusIn } : {}),
      page: opts.page,
      pageSize: LIST_PAGE_SIZE,
    };

    const { items, total } =
      profile.profile_type === 'WORKER'
        ? await this.applicationService.findByWorker(profile.id, filter)
        : await this.applicationService.findByEmployer(profile.id, filter);

    if (total === 0) {
      return {
        message: opts.emptyMessage,
        applicationIds: [],
        page: 0,
        totalPages: 0,
      };
    }

    const list: ApplicationForList[] = items.map((a) => ({
      id: a.id,
      status: a.status,
      job_offer: {
        id: a.job_offer.id,
        title: a.job_offer.title,
        scheduled_at: a.job_offer.scheduled_at,
        amount: a.job_offer.amount,
        payment_flow: a.job_offer.payment_flow,
        address: a.job_offer.address,
        status: a.job_offer.status,
      },
    }));

    return {
      message: formatMyApplicationsListPage({
        title: opts.title,
        applications: list,
        total,
        page: opts.page,
        pageSize: LIST_PAGE_SIZE,
      }),
      applicationIds: items.map((a) => a.id),
      page: opts.page,
      totalPages: Math.ceil(total / LIST_PAGE_SIZE),
    };
  }

  async myOffers(
    profile: BotProfile,
    page = 0,
  ): Promise<{ message: string; offerIds: string[] }> {
    if (profile.profile_type !== 'EMPLOYER') {
      return {
        message:
          '❌ Seuls les employeurs peuvent voir leurs offres. Tapez *Menu* pour revenir.',
        offerIds: [],
      };
    }
    const PAGE_SIZE = 5;
    const { items: pageOffers, total } =
      await this.jobOfferService.findByEmployerId(profile.id, {
        page,
        pageSize: PAGE_SIZE,
      });
    if (total === 0) {
      return {
        message: "Vous n'avez publié aucune offre. Tapez *Menu* pour revenir.",
        offerIds: [],
      };
    }
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const hasMore = start + PAGE_SIZE < total;
    const pageLabel = totalPages > 1 ? ` — page ${page + 1}/${totalPages}` : '';
    const lines = [`*Mes offres publiées (${total})${pageLabel}*`, ''];
    pageOffers.forEach((o, i) => {
      const num = start + i + 1;
      const title =
        o.title.length > 40 ? o.title.slice(0, 40) + '...' : o.title;
      const dateStr = o.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      lines.push(
        `${num}- *${title}*`,
        `    • Réf : \`${o.reference}\``,
        `    • Date : ${dateStr}`,
        `    • Montant : ${o.amount != null ? `${o.amount.toLocaleString('fr-FR')} FCFA` : 'Prix à négocier'}`,
        `    • Statut : ${translateJobOfferStatus(o.status)}`,
        '',
      );
    });
    const actions: string[] = [];
    if (page > 0) actions.push('P- Page précédente');
    if (hasMore) actions.push('S- Page suivante');
    actions.push('M- Menu principal');
    lines.push(...actions);
    return { message: lines.join('\n'), offerIds: pageOffers.map((o) => o.id) };
  }

  async candidaturesReceived(profile: BotProfile): Promise<{
    message: string;
    applicationIds?: string[];
    items?: CandidatureListItem[];
  }> {
    if (profile.profile_type !== 'EMPLOYER') {
      return {
        message:
          '❌ Seuls les employeurs peuvent voir les candidatures reçues.',
      };
    }
    // Single query: all pending/viewed applications across all employer's offers
    const pendingApps = await this.prisma.application.findMany({
      where: {
        job_offer: { employer_id: profile.id },
        status: { in: ['PENDING', 'VIEWED'] },
      },
      include: {
        worker: true,
        job_offer: { select: { title: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const allItems: CandidatureListItem[] = [];
    if (pendingApps.length > 0) {
      // Batch-count completed missions per worker in one query
      const workerIds = [
        ...new Set(pendingApps.map((a) => a.worker_id).filter(Boolean)),
      ] as string[];
      const missionCounts = await this.prisma.application.groupBy({
        by: ['worker_id'],
        where: { worker_id: { in: workerIds }, status: 'END' },
        _count: { id: true },
      });
      const countByWorker = new Map(
        missionCounts.map((r) => [r.worker_id, r._count.id]),
      );

      for (const app of pendingApps) {
        const w = app.worker;
        allItems.push({
          id: app.id,
          fullName: w ? `${w.first_name} ${w.last_name}` : 'Inconnu',
          score: w?.reliability_score ?? '?',
          firstName: w?.first_name ?? '',
          lastName: w?.last_name ?? '',
          email: w?.email ?? '',
          status: w?.verification_status ?? app.status,
          avatarUrl: w?.avatar_url ?? undefined,
          offerTitle: app.job_offer?.title ?? '',
          description: w?.description ?? null,
          completedMissions: countByWorker.get(app.worker_id ?? '') ?? 0,
          memberSince: w?.created_at ?? null,
        });
      }
    }
    if (allItems.length === 0) {
      return {
        message: 'Aucune candidature en attente pour vos offres. Tapez *Menu*.',
      };
    }
    const applicationIds = allItems.map((a) => a.id);
    const firstPage = allItems.slice(0, 5);
    const hasMore = allItems.length > 5;
    const message = formatCandidaturesListPage(firstPage, hasMore);
    return {
      message,
      applicationIds,
      items: allItems,
    };
  }

  async filledJobs(profile: BotProfile): Promise<{
    message: string;
    items?: FilledJobListItem[];
  }> {
    if (profile.profile_type !== 'EMPLOYER') {
      return {
        message: '❌ Seuls les employeurs peuvent voir les missions pourvues.',
      };
    }
    // Single query: all accepted/waiting applications for employer's filled offers
    const activeApps = await this.prisma.application.findMany({
      where: {
        job_offer: {
          employer_id: profile.id,
          status: { in: [JobOfferStatus.FILLED, JobOfferStatus.PARTIALLY_FILLED] },
        },
        status: { in: ['ACCEPTED', 'WAITING_PAYMENT'] },
      },
      include: {
        worker: { select: { first_name: true, last_name: true } },
        job_offer: {
          select: {
            title: true,
            scheduled_at: true,
            amount: true,
            payment_flow: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    const items: FilledJobListItem[] = activeApps
      .filter((app) => app.worker && app.job_offer)
      .map((app) => ({
        applicationId: app.id,
        title: app.job_offer!.title,
        workerName:
          `${app.worker!.first_name} ${app.worker!.last_name}`.trim() ||
          'Inconnu',
        scheduled_at: app.job_offer!.scheduled_at,
        amount: app.job_offer!.amount !== null ? Number(app.job_offer!.amount) : null,
        payment_flow: app.job_offer!.payment_flow,
        status: app.status,
      }));
    if (items.length === 0) {
      return {
        message:
          'Aucune mission pourvue pour le moment. Tapez *Menu* pour revenir.',
      };
    }
    const firstPage = items.slice(0, 5);
    const hasMore = items.length > 5;
    const message = formatFilledJobsListPage(firstPage, hasMore);
    return { message, items };
  }

  async profile(profile: BotProfile): Promise<string> {
    const profileData = await this.prisma.profile.findUnique({
      where: { id: profile.id },
      select: {
        first_name: true,
        last_name: true,
        email: true,
        reliability_score: true,
        created_at: true,
        avatar_url: true,
        profile_type: true,
      },
    });

    if (!profileData) return 'Profil non trouvé. Tapez *Menu*.';

    const walletBalance = await this.walletService
      .getProfileWalletBalance(profile.id)
      .catch(() => 0);

    if (profileData.profile_type === 'EMPLOYER') {
      const [offersCount, pendingCandidaturesCount] = await Promise.all([
        this.prisma.jobOffer.count({ where: { employer_id: profile.id } }),
        this.prisma.application.count({
          where: {
            job_offer: { employer_id: profile.id },
            status: 'PENDING',
          },
        }),
      ]);
      const activeOffersCount = await this.prisma.jobOffer.count({
        where: {
          employer_id: profile.id,
          status: JobOfferStatus.ACTIVE,
        },
      });
      const profileText = formatEmployerProfileStats({
        firstName: profileData.first_name,
        lastName: profileData.last_name,
        email: profileData.email,
        memberSince: profileData.created_at,
        offersCount,
        pendingCandidaturesCount,
        activeOffersCount,
        walletBalance,
      });
      if (profileData.avatar_url?.trim()) {
        return `[IMG:${profileData.avatar_url}]\n${profileText}`;
      }
      return profileText;
    }

    const [applications, penalties] = await Promise.all([
      this.applicationService.findByWorker(profile.id, { limit: 500 }),
      this.prisma.penalty.findMany({
        where: { profile_id: profile.id },
        orderBy: { applied_at: 'desc' },
        include: {
          application: { include: { job_offer: true } },
        },
      }),
    ]);

    const completed = applications.filter(
      (a) =>
        a.status === ApplicationStatus.ACCEPTED &&
        a.job_offer?.status === JobOfferStatus.COMPLETED,
    );
    const completionRate =
      applications.length > 0
        ? Math.round((completed.length / applications.length) * 100)
        : 100;
    const totalPenalties = penalties.reduce((s, p) => s + Number(p.amount), 0);
    const lateCount = penalties.length;

    const profileText = formatProfileStats({
      firstName: profileData.first_name,
      lastName: profileData.last_name,
      email: profileData.email,
      reliabilityScore: profileData.reliability_score,
      memberSince: profileData.created_at,
      completedMissions: completed.length,
      completionRate,
      totalPenalties,
      lateCancellations: lateCount,
      walletBalance,
    });
    if (profileData.avatar_url?.trim()) {
      return `[IMG:${profileData.avatar_url}]\n${profileText}`;
    }
    return profileText;
  }

  async penaltyHistory(profile: BotProfile): Promise<string> {
    const isEmployer = profile.profile_type === 'EMPLOYER';

    const [penalties, completedMissionItems, completedCount] =
      await Promise.all([
        this.prisma.penalty.findMany({
          where: { profile_id: profile.id },
          orderBy: { applied_at: 'desc' },
          include: {
            application: { include: { job_offer: true } },
          },
        }),
        isEmployer
          ? this.prisma.jobOffer
              .findMany({
                where: {
                  employer_id: profile.id,
                  status: JobOfferStatus.COMPLETED,
                },
                select: { title: true, scheduled_at: true, amount: true },
                orderBy: { scheduled_at: 'desc' },
                take: 10,
              })
              .then((rows) =>
                rows.map((o) => ({
                  title: o.title,
                  scheduled_at: o.scheduled_at,
                  amount: o.amount != null ? Number(o.amount) : null,
                })),
              )
          : this.prisma.application
              .findMany({
                where: {
                  worker_id: profile.id,
                  status: ApplicationStatus.ACCEPTED,
                  job_offer: { status: JobOfferStatus.COMPLETED },
                },
                select: {
                  created_at: true,
                  job_offer: {
                    select: { title: true, scheduled_at: true, amount: true },
                  },
                },
                orderBy: { created_at: 'desc' },
                take: 10,
              })
              .then((rows) =>
                rows.map((a) => ({
                  title: a.job_offer.title,
                  scheduled_at: a.job_offer.scheduled_at,
                  amount:
                    a.job_offer.amount != null
                      ? Number(a.job_offer.amount)
                      : null,
                })),
              ),
        isEmployer
          ? this.prisma.jobOffer.count({
              where: {
                employer_id: profile.id,
                status: JobOfferStatus.COMPLETED,
              },
            })
          : this.prisma.application.count({
              where: {
                worker_id: profile.id,
                status: ApplicationStatus.ACCEPTED,
                job_offer: { status: JobOfferStatus.COMPLETED },
              },
            }),
      ]);

    const totalAmount = penalties.reduce((s, p) => s + Number(p.amount), 0);
    const score = profile.reliability_score ?? 100;

    const items: PenaltyItem[] = penalties.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      reason: p.reason,
      appliedAt: p.applied_at,
      jobOfferTitle: p.application?.job_offer?.title,
    }));

    const { cancellationThresholdHours } = await this.systemConfig.getFees();

    return formatHistoryMessage(
      completedMissionItems,
      items,
      totalAmount,
      penalties.length,
      score,
      completedCount,
      cancellationThresholdHours,
    );
  }
}
