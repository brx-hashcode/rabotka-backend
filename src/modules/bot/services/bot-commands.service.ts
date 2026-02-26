import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
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
  formatFilledJobDetail,
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
    const applications = await this.applicationService.findByWorker(
      profile.id,
      { limit: 20 },
    );
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

  async myOffers(profile: BotProfile): Promise<string> {
    if (profile.profile_type !== 'EMPLOYER') {
      return "*SEULS LES EMPLOYEURS PEUVENT VOIR LEURS OFFRES. TAPEZ 'MENU' POUR REVENIR.*";
    }
    const offers = await this.jobOfferService.findByEmployerId(profile.id);
    if (offers.length === 0) {
      return "*VOUS N'AVEZ PUBLIÉ AUCUNE OFFRE. TAPEZ 1 POUR PUBLIER UNE OFFRE.*";
    }
    const lines = [`*MES OFFRES PUBLIÉES (${offers.length})*`, ''];
    offers.forEach((o, i) => {
      const num = i + 1;
      const dateStr = o.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      lines.push(
        `${num}. ${o.title}`,
        `    ID: #${o.id.slice(0, 8)}`,
        `    Date: ${dateStr}`,
        `    Montant: ${o.amount.toLocaleString('fr-FR')} FCFA`,
        `    Statut: ${o.status}`,
        '',
      );
    });
    lines.push("Veuillez taper 'Menu' pour revenir au menu.");
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
      const pending = applications.filter((a) => a.status === 'PENDING');
      for (const app of pending) {
        const firstName = app.worker?.first_name ?? '';
        const lastName = app.worker?.last_name ?? '';
        const fullName = app.worker
          ? `${app.worker.first_name} ${app.worker.last_name}`
          : 'Inconnu';
        const score = app.worker?.reliability_score ?? '?';
        const email = app.worker?.email ?? '';
        const avatarUrl = app.worker?.avatar_url;
        allItems.push({
          id: app.id,
          fullName,
          score,
          firstName,
          lastName,
          email,
          status: app.status,
          avatarUrl: avatarUrl ?? undefined,
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
    const filledOffers = offers.filter((o) => o.status === JobOfferStatus.FILLED);
    const items: FilledJobListItem[] = [];
    for (const offer of filledOffers) {
      const applications = await this.applicationService.findByJobOffer(
        offer.id,
      );
      const accepted = applications.find((a) => a.status === 'ACCEPTED');
      if (!accepted?.worker) continue;
      const workerName = `${accepted.worker.first_name} ${accepted.worker.last_name}`.trim() || 'Inconnu';
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
      });
      if (profileData.avatar_url) {
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
    });
    if (profileData.avatar_url) {
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
