import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { WalletService } from '../../wallet/wallet.service';
import type { BotProfile } from '../types/bot-state.types';
import {
  formatOfferListCompact,
  formatOfferDetail,
  formatNoOffersAvailable,
  type OfferListItem,
} from '../messages/offers.messages';
import {
  formatMyApplicationsList,
  formatCandidaturesListPage,
  formatFilledJobsListPage,
  type ApplicationForList,
  type CandidatureListItem,
  type FilledJobListItem,
} from '../messages/application.messages';
import {
  formatPenaltyHistory,
  formatProfileStats,
  formatEmployerProfileStats,
  type PenaltyItem,
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
  ) {}

  async listOffers(
    profile: BotProfile,
    pageCursor?: string,
  ): Promise<{
    message: string;
    offerIds?: string[];
    nextCursor?: string | null;
  }> {
    const { data, nextCursor } = await this.jobOfferService.findActive(
      LIST_PAGE_SIZE,
      pageCursor,
      profile.id,
    );
    if (data.length === 0) {
      return { message: formatNoOffersAvailable() };
    }
    const offers: OfferListItem[] = data.map((o) => ({
      id: o.id,
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
    const message = formatOfferListCompact(offers, hasMore);
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

  async myApplications(
    profile: BotProfile,
  ): Promise<{ message: string; applicationIds?: string[] }> {
    const applications =
      profile.profile_type === 'WORKER'
        ? await this.applicationService.findByWorker(profile.id, { limit: 20 })
        : await this.applicationService.findByEmployer(profile.id, {
            limit: 20,
          });
    if (applications.length === 0) {
      return {
        message: formatMyApplicationsList([]),
      };
    }
    const list: ApplicationForList[] = applications.map((a) => ({
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
      message: formatMyApplicationsList(list),
      applicationIds: applications.map((a) => a.id),
    };
  }

  async pendingPayments(
    profile: BotProfile,
  ): Promise<{ message: string; applicationIds?: string[] }> {
    const applications =
      profile.profile_type === 'WORKER'
        ? await this.applicationService.findByWorker(profile.id, {
            status: 'WAITING_PAYMENT' as ApplicationStatus,
            limit: 20,
          })
        : await this.applicationService.findByEmployer(profile.id, {
            status: 'WAITING_PAYMENT' as ApplicationStatus,
            limit: 20,
          });

    if (applications.length === 0) {
      return {
        message:
          '✅ *Aucun paiement en attente* pour le moment.\n\nTapez *Menu* pour revenir.',
      };
    }

    const list: ApplicationForList[] = applications.map((a) => ({
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
      message: formatMyApplicationsList(list),
      applicationIds: applications.map((a) => a.id),
    };
  }

  async myOffers(profile: BotProfile, page = 0): Promise<string> {
    if (profile.profile_type !== 'EMPLOYER') {
      return "*SEULS LES EMPLOYEURS PEUVENT VOIR LEURS OFFRES. TAPEZ 'MENU' POUR REVENIR.*";
    }
    const PAGE_SIZE = 5;
    const { items: pageOffers, total } =
      await this.jobOfferService.findByEmployerId(profile.id, {
        page,
        pageSize: PAGE_SIZE,
      });
    if (total === 0) {
      return "*VOUS N'AVEZ PUBLIÉ AUCUNE OFFRE. TAPEZ 'MENU' POUR REVENIR.*";
    }
    const start = page * PAGE_SIZE;
    const hasMore = start + PAGE_SIZE < total;
    const lines = [`*MES OFFRES PUBLIÉES (${total})*`, ''];
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
        `    • Date : ${dateStr}`,
        `    • Montant : ${o.amount != null ? `${o.amount.toLocaleString('fr-FR')} FCFA` : 'Prix à négocier'}`,
        `    • Statut : ${o.status}`,
        '',
      );
    });
    if (hasMore) {
      lines.push(`${start + PAGE_SIZE + 1} - Voir plus`, '');
    }
    lines.push('Tapez *Menu* pour revenir au menu.');
    return lines.join('\n');
  }

  async candidaturesReceived(profile: BotProfile): Promise<{
    message: string;
    applicationIds?: string[];
    items?: CandidatureListItem[];
  }> {
    if (profile.profile_type !== 'EMPLOYER') {
      return {
        message: '*SEULS LES EMPLOYEURS PEUVENT VOIR LES CANDIDATURES REÇUES.*',
      };
    }
    const offers = await this.jobOfferService.findByEmployerId(profile.id);
    const allItems: CandidatureListItem[] = [];
    for (const offer of offers) {
      const applications = await this.applicationService.findByJobOffer(
        offer.id,
      );
      const pending = applications.filter(
        (a) => a.status === 'PENDING' || a.status === 'VIEWED',
      );
      for (const app of pending) {
        const firstName = app.worker?.first_name ?? '';
        const lastName = app.worker?.last_name ?? '';
        const fullName = app.worker
          ? `${app.worker.first_name} ${app.worker.last_name}`
          : 'Inconnu';
        const score = app.worker?.reliability_score ?? '?';
        const email = app.worker?.email ?? '';
        const avatarUrl = app.worker?.avatar_url;
        const verificationStatus = app.worker?.verification_status;
        allItems.push({
          id: app.id,
          fullName,
          score,
          firstName,
          lastName,
          email,
          status: verificationStatus ?? app.status,
          avatarUrl: avatarUrl ?? undefined,
          offerTitle: offer.title,
        });
      }
    }
    if (allItems.length === 0) {
      return {
        message: "Aucune candidature en attente pour vos offres. Tapez 'Menu'.",
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
        message: '*SEULS LES EMPLOYEURS PEUVENT VOIR LES MISSIONS POURVUES.*',
      };
    }
    const offers = await this.jobOfferService.findByEmployerId(profile.id);
    const filledOffers = offers.filter(
      (o) => o.status === JobOfferStatus.FILLED,
    );
    const items: FilledJobListItem[] = [];
    for (const offer of filledOffers) {
      const applications = await this.applicationService.findByJobOffer(
        offer.id,
      );
      const accepted = applications.find((a) => a.status === 'ACCEPTED');
      if (!accepted?.worker) continue;
      const workerName =
        `${accepted.worker.first_name} ${accepted.worker.last_name}`.trim() ||
        'Inconnu';
      items.push({
        applicationId: accepted.id,
        title: offer.title,
        workerName,
        scheduled_at: offer.scheduled_at,
        amount: offer.amount,
        payment_flow: offer.payment_flow,
      });
    }
    if (items.length === 0) {
      return {
        message:
          "Aucune mission pourvue pour le moment. Tapez 'Menu' pour revenir.",
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

    if (!profileData) return "Profil non trouvé. Tapez 'Menu'.";

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
        return `[IMG:${profileData.avatar_url}]${profileText}`;
      }
      return profileText;
    }

    const [applications, penalties] = await Promise.all([
      this.applicationService.findByWorker(profile.id, { limit: 500 }),
      this.prisma.penalty.findMany({
        where: { worker_id: profile.id },
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
    const totalEarnings = completed.reduce(
      (sum, a) => sum + (a.job_offer?.amount ?? 0),
      0,
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
      totalEarnings,
      completionRate,
      totalPenalties,
      lateCancellations: lateCount,
      walletBalance,
    });
    if (profileData.avatar_url?.trim()) {
      return `[IMG:${profileData.avatar_url}]${profileText}`;
    }
    return profileText;
  }

  async penaltyHistory(profile: BotProfile): Promise<string> {
    const [penalties, applications] = await Promise.all([
      this.prisma.penalty.findMany({
        where: { worker_id: profile.id },
        orderBy: { applied_at: 'desc' },
        include: {
          application: { include: { job_offer: true } },
        },
      }),
      this.applicationService.findByWorker(profile.id, { limit: 500 }),
    ]);

    const totalAmount = penalties.reduce((s, p) => s + Number(p.amount), 0);
    const completed = applications.filter(
      (a) =>
        a.status === ApplicationStatus.ACCEPTED &&
        a.job_offer?.status === JobOfferStatus.COMPLETED,
    ).length;
    const score = profile.reliability_score ?? 100;

    const items: PenaltyItem[] = penalties.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      reason: p.reason,
      appliedAt: p.applied_at,
      jobOfferTitle: p.application?.job_offer?.title,
    }));

    return formatPenaltyHistory(
      items,
      totalAmount,
      penalties.length,
      score,
      completed,
    );
  }
}
