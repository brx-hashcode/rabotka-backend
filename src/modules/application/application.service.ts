import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import {
  AccountStatus,
  ApplicationStatus,
  AssignmentStatus,
  BillingStatus,
  JobOfferStatus,
  PaymentStatus,
  PaymentMethod,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { ContractService } from '../contract/contract.service';
import {
  LATE_CANCELLATION_PENALTY_FCFA,
  LATE_CANCELLATION_SCORE_DEDUCTION,
  CANCELLATION_PENALTY_THRESHOLD_HOURS,
  RELIABILITY_SCORE_MIN,
  RELIABILITY_SCORE_MAX,
  EMPLOYER_CANCEL_SCORE_DEDUCTION,
  BILLING_BLOCK_THRESHOLD,
  PENALTY_SUSPENSION_THRESHOLD,
} from './application.constants';

export type AdminApplicationListItem = {
  id: string;
  jobTitle: string;
  jobOfferId: string;
  workerName: string;
  workerEmail: string;
  workerPhone: string;
  workerAvatarUrl: string | null;
  workerId: string;
  employerName: string;
  employerEmail: string;
  employerAvatarUrl: string | null;
  employerId: string;
  status: string;
  penaltyApplied: boolean;
  penaltyAmount: number | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminApplicationPenaltyItem = {
  id: string;
  amount: number;
  reason: string | null;
  appliedAt: string;
  paidAt: string | null;
};

export type AdminApplicationDetailResponse = AdminApplicationListItem & {
  jobScheduledAt: string;
  jobAmount: number;
  jobAddress: string;
  jobPaymentFlow: string;
  jobStatus: string;
  jobQuantity: number;
  workerReliabilityScore: number | null;
  employerPhone: string;
  penalties: AdminApplicationPenaltyItem[];
  completionNote: string | null;
  contractId: string | null;
};

export type ApplicationListItem = {
  id: string;
  job_offer_id: string;
  worker_id: string;
  status: string;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  penalty_applied: boolean;
  penalty_amount: number | null;
  created_at: Date;
  job_offer?: {
    id: string;
    title: string;
    scheduled_at: Date;
    amount: number;
    address: string;
    status: string;
    employer_id: string;
  };
  worker?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    email: string;
    description: string;
    reliability_score: number | null;
    verification_status: string;
    avatar_url?: string | null;
  };
};

export type ApplicationWithOffer = ApplicationListItem & {
  job_offer: {
    id: string;
    title: string;
    description: string;
    scheduled_at: Date;
    amount: number;
    payment_flow: string;
    address: string;
    note: string | null;
    status: string;
    employer_id: string;
    employer?: {
      id: string;
      first_name: string;
      last_name: string;
      phone: string;
    };
  };
};

@Injectable()
export class ApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BotNotificationService))
    private readonly botNotification: BotNotificationService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => ContactUnlockService))
    private readonly contactUnlock: ContactUnlockService,
    private readonly contractService: ContractService,
  ) {}

  async create(
    jobOfferId: string,
    workerId: string,
  ): Promise<ApplicationListItem> {
    const [jobOffer, worker] = await Promise.all([
      this.prisma.jobOffer.findUnique({
        where: { id: jobOfferId },
        include: { employer: true },
      }),
      this.prisma.profile.findUnique({
        where: { id: workerId },
        select: { id: true, status: true, profile_type: true },
      }),
    ]);

    if (!jobOffer) {
      throw new NotFoundException('Offre non trouvée');
    }
    if (!worker) {
      throw new NotFoundException('Profil worker non trouvé');
    }
    if (worker.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException(
        'Votre compte doit être actif pour postuler',
      );
    }
    if (worker.profile_type !== 'WORKER') {
      throw new ForbiddenException(
        'Seuls les workers peuvent postuler aux offres',
      );
    }
    if (jobOffer.status !== JobOfferStatus.ACTIVE) {
      throw new BadRequestException("Cette offre n'est plus disponible");
    }
    if (jobOffer.employer_id === workerId) {
      throw new BadRequestException(
        'Vous ne pouvez pas postuler à votre propre offre',
      );
    }

    const unpaidPenaltiesCount = await this.prisma.penalty.count({
      where: {
        worker_id: workerId,
        paid_at: null,
      },
    });
    if (unpaidPenaltiesCount > 0) {
      throw new ForbiddenException(
        'Vous avez des pénalités impayées. Tapez PAYER pour les régler et débloquer votre compte.',
      );
    }

    const existing = await this.prisma.application.findUnique({
      where: {
        idx_application_unique: {
          job_offer_id: jobOfferId,
          worker_id: workerId,
        },
      },
    });
    if (existing) {
      throw new ConflictException('Vous avez déjà postulé à cette offre');
    }

    const application = await this.prisma.application.create({
      data: {
        job_offer_id: jobOfferId,
        worker_id: workerId,
        status: ApplicationStatus.PENDING,
      },
      include: {
        job_offer: true,
      },
    });

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_CREATED, {
      event: AdminNotificationEvent.APPLICATION_CREATED,
      title: 'Nouvelle candidature',
      message: `Nouvelle candidature pour l'offre "${application.job_offer.title}"`,
      entityType: 'application',
      entityId: String(application.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(application);
  }

  async findByWorker(
    workerId: string,
    options?: { status?: ApplicationStatus; limit?: number },
  ): Promise<ApplicationWithOffer[]> {
    const limit = Math.min(options?.limit ?? 50, 100);
    const applications = await this.prisma.application.findMany({
      where: {
        worker_id: workerId,
        ...(options?.status ? { status: options.status } : {}),
      },
      take: limit,
      orderBy: { created_at: 'desc' },
      include: {
        job_offer: {
          include: {
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
          },
        },
        worker: true,
      },
    });

    return applications.map((a) => this.toApplicationWithOffer(a));
  }

  async findByJobOffer(jobOfferId: string): Promise<ApplicationWithOffer[]> {
    const applications = await this.prisma.application.findMany({
      where: { job_offer_id: jobOfferId },
      orderBy: { created_at: 'desc' },
      include: {
        job_offer: {
          include: {
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
          },
        },
        worker: true,
      },
    });

    return applications.map((a) => this.toApplicationWithOffer(a));
  }

  async findById(id: string): Promise<ApplicationWithOffer | null> {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        job_offer: {
          include: {
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
          },
        },
        worker: true,
      },
    });
    if (!application) return null;
    return this.toApplicationWithOffer(application);
  }

  async accept(
    applicationId: string,
    employerId: string,
  ): Promise<ApplicationWithOffer> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true, worker: true },
    });

    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.job_offer.employer_id !== employerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }
    if (
      application.status !== ApplicationStatus.PENDING &&
      application.status !== ApplicationStatus.VIEWED
    ) {
      throw new BadRequestException("Cette candidature n'est plus en attente");
    }

    const currentAcceptedCount = await this.prisma.application.count({
      where: {
        job_offer_id: application.job_offer_id,
        status: ApplicationStatus.ACCEPTED,
      },
    });

    const quantityNeeded = application.job_offer.quantity ?? 1;
    const newAcceptedCount = currentAcceptedCount + 1;
    let offerStatus: JobOfferStatus;
    if (newAcceptedCount >= quantityNeeded) {
      offerStatus = JobOfferStatus.FILLED;
    } else if (newAcceptedCount > 0) {
      offerStatus = JobOfferStatus.PARTIALLY_FILLED;
    } else {
      offerStatus = JobOfferStatus.ACTIVE;
    }

    await this.prisma.$transaction([
      this.prisma.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.ACCEPTED },
      }),
      this.prisma.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: offerStatus },
      }),
      this.prisma.assignment.create({
        data: {
          application_id: applicationId,
          job_offer_id: application.job_offer_id,
          worker_id: application.worker_id,
          status: AssignmentStatus.CONFIRMED,
        },
      }),
    ]);

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Candidature introuvable après mise à jour');

    // Initiate contact unlock attempt — contacts are now gated behind payment/credit
    this.contactUnlock
      .initiateUnlock(applicationId, employerId)
      .catch((err) =>
        console.warn(`Failed to initiate contact unlock for ${applicationId}:`, err),
      );

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_ACCEPTED, {
      event: AdminNotificationEvent.APPLICATION_ACCEPTED,
      title: 'Candidature acceptée',
      message: `La candidature de ${application.worker.first_name} ${application.worker.last_name} pour l'offre "${application.job_offer.title}" a été acceptée`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    // Create contract metadata (no PDF generated here — on-demand via GET /contracts/:id/download)
    this.contractService
      .create(applicationId)
      .catch((err) => console.warn(`Failed to create contract metadata for ${applicationId}:`, err));

    return updated;
  }

  async reject(
    applicationId: string,
    employerId: string,
    reason?: string,
  ): Promise<ApplicationWithOffer> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true },
    });

    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.job_offer.employer_id !== employerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }
    if (
      application.status !== ApplicationStatus.PENDING &&
      application.status !== ApplicationStatus.VIEWED
    ) {
      throw new BadRequestException("Cette candidature n'est plus en attente");
    }

    const updated = await this.prisma.application.update({
      where: { id: applicationId },
      data: { status: ApplicationStatus.REJECTED },
      include: {
        job_offer: {
          include: {
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
          },
        },
        worker: true,
      },
    });

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_REJECTED, {
      event: AdminNotificationEvent.APPLICATION_REJECTED,
      title: 'Candidature refusée',
      message: `La candidature de ${updated.worker.first_name} ${updated.worker.last_name} pour l'offre "${updated.job_offer.title}" a été refusée`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    return this.toApplicationWithOffer(updated);
  }

  async cancel(
    applicationId: string,
    workerId: string,
    reason?: string,
  ): Promise<{
    application: ApplicationWithOffer;
    penaltyApplied: boolean;
    penaltyAmount: number | null;
  }> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true, worker: true },
    });

    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.worker_id !== workerId) {
      throw new ForbiddenException(
        'Vous ne pouvez annuler que vos propres candidatures',
      );
    }
    if (
      application.status !== ApplicationStatus.ACCEPTED &&
      application.status !== ApplicationStatus.PENDING
    ) {
      throw new BadRequestException(
        'Cette candidature ne peut plus être annulée',
      );
    }

    const now = new Date();
    const scheduledAt = application.job_offer.scheduled_at;
    const hoursUntil =
      (scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000);
    const isLateCancellation =
      hoursUntil < CANCELLATION_PENALTY_THRESHOLD_HOURS;
    const isAccepted = application.status === ApplicationStatus.ACCEPTED;
    const applyPenalty = isLateCancellation && isAccepted;

    const penaltyApplied = applyPenalty;
    const penaltyAmount: number | null = applyPenalty
      ? LATE_CANCELLATION_PENALTY_FCFA
      : null;

    await this.prisma.$transaction(async (tx) => {
      if (isAccepted) {
        // Compute remaining accepted count (excluding this application)
        const remainingAccepted = await tx.application.count({
          where: {
            job_offer_id: application.job_offer_id,
            status: ApplicationStatus.ACCEPTED,
            id: { not: applicationId },
          },
        });
        const reopenStatus =
          remainingAccepted > 0
            ? JobOfferStatus.PARTIALLY_FILLED
            : JobOfferStatus.ACTIVE;
        await tx.jobOffer.update({
          where: { id: application.job_offer_id },
          data: { status: reopenStatus },
        });
        await tx.assignment.updateMany({
          where: { application_id: applicationId },
          data: {
            status: AssignmentStatus.CANCELLED_BY_WORKER,
            cancelled_at: now,
          },
        });
      }

      if (applyPenalty) {
        await tx.penalty.create({
          data: {
            worker_id: workerId,
            application_id: applicationId,
            amount: LATE_CANCELLATION_PENALTY_FCFA,
            reason:
              reason ??
              `Annulation tardive (< ${CANCELLATION_PENALTY_THRESHOLD_HOURS}h avant le rendez-vous)`,
          },
        });

        const profile = await tx.profile.findUnique({
          where: { id: workerId },
          select: { reliability_score: true },
        });
        const currentScore = profile?.reliability_score ?? 100;
        const newScore = Math.max(
          RELIABILITY_SCORE_MIN,
          Math.min(
            RELIABILITY_SCORE_MAX,
            currentScore - LATE_CANCELLATION_SCORE_DEDUCTION,
          ),
        );
        await tx.profile.update({
          where: { id: workerId },
          data: { reliability_score: newScore },
        });
        await this.syncBillingStatus(workerId, tx);
      }

      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason: reason ?? null,
          penalty_applied: penaltyApplied,
          penalty_amount: penaltyAmount,
        },
      });
    });

    // Suspension check after penalty creation
    if (applyPenalty) {
      const unpaidCount = await this.prisma.penalty.count({
        where: { worker_id: workerId, paid_at: null },
      });
      if (unpaidCount >= PENALTY_SUSPENSION_THRESHOLD) {
        const workerProfile = await this.prisma.profile.update({
          where: { id: workerId },
          data: { status: AccountStatus.SUSPENDED },
        });
        const total = unpaidCount * LATE_CANCELLATION_PENALTY_FCFA;
        await this.botNotification.sendMessage(
          workerProfile.phone,
          `⚠️ Compte suspendu\n\nVotre compte Rabotka a été suspendu en raison de ${unpaidCount} pénalités impayées\n(total : ${total.toLocaleString('fr-FR')} FCFA).\n\nVous ne pouvez plus accéder aux fonctionnalités tant que vos pénalités ne sont pas réglées.\n\n1 – Régler mes pénalités\n2 – Annuler`,
        );
      }
    }

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Candidature introuvable après mise à jour');

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_CANCELLED, {
      event: AdminNotificationEvent.APPLICATION_CANCELLED,
      title: 'Candidature annulée',
      message: `La candidature de ${application.worker.first_name} ${application.worker.last_name} pour l'offre "${application.job_offer.title}" a été annulée par le travailleur`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    if (penaltyApplied) {
      this.eventEmitter.emit(AdminNotificationEvent.PENALTY_CREATED, {
        event: AdminNotificationEvent.PENALTY_CREATED,
        title: 'Pénalité créée',
        message: `Pénalité de ${penaltyAmount} FCFA créée pour annulation tardive de ${application.worker.first_name} ${application.worker.last_name} sur l'offre "${application.job_offer.title}"`,
        entityType: 'penalty',
        entityId: String(applicationId),
        timestamp: new Date().toISOString(),
      });
    }

    return {
      application: updated,
      penaltyApplied,
      penaltyAmount,
    };
  }

  /** Returns whether cancellation would incur a penalty (worker cancelled < 4h before) */
  async wouldPenalizeCancellation(
    applicationId: string,
    workerId: string,
  ): Promise<boolean> {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true },
    });
    if (app?.worker_id !== workerId) return false;
    if (
      app.status !== ApplicationStatus.ACCEPTED &&
      app.status !== ApplicationStatus.PENDING
    )
      return false;
    const now = new Date();
    const hoursUntil =
      (app.job_offer.scheduled_at.getTime() - now.getTime()) / (60 * 60 * 1000);
    return hoursUntil < CANCELLATION_PENALTY_THRESHOLD_HOURS && hoursUntil >= 0;
  }

  /** Employer marks job as completed: set JobOffer to COMPLETED and create Payment for worker */
  async markJobCompleted(
    applicationId: string,
    employerId: string,
    note?: string,
  ): Promise<ApplicationWithOffer> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true, worker: true },
    });
    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.job_offer.employer_id !== employerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }
    if (
      application.status !== ApplicationStatus.ACCEPTED &&
      application.status !== ApplicationStatus.STARTED
    ) {
      throw new BadRequestException(
        'Seule une candidature acceptée ou démarrée peut être marquée comme terminée',
      );
    }
    if (application.job_offer.status === JobOfferStatus.COMPLETED) {
      throw new BadRequestException(
        'Cette mission est déjà marquée comme terminée',
      );
    }

    const amount = Number(application.job_offer.amount);
    const transactionId = generatePaymentReference();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: JobOfferStatus.COMPLETED },
      });
      await tx.assignment.updateMany({
        where: { application_id: applicationId },
        data: { status: AssignmentStatus.COMPLETED, completed_at: now, note: note ?? null },
      });
      await tx.payment.create({
        data: {
          type: PaymentType.JOB_POSTING,
          profile_id: application.worker_id,
          amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: transactionId,
          status: PaymentStatus.COMPLETED,
          paid_at: now,
          description: `Job completion payment for job ${application.job_offer_id}`,
        },
      });
      // Mark all accepted/started applications for this job as END
      await tx.application.updateMany({
        where: {
          job_offer_id: application.job_offer_id,
          status: {
            in: [ApplicationStatus.ACCEPTED, ApplicationStatus.STARTED],
          },
        },
        data: { status: ApplicationStatus.END },
      });
      // Boost worker reliability score on successful completion
      const worker = await tx.profile.findUnique({
        where: { id: application.worker_id },
        select: { reliability_score: true },
      });
      const currentScore = worker?.reliability_score ?? 100;
      const boostedScore = Math.min(RELIABILITY_SCORE_MAX, currentScore + 2);
      if (boostedScore > currentScore) {
        await tx.profile.update({
          where: { id: application.worker_id },
          data: { reliability_score: boostedScore },
        });
      }
    });

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Candidature introuvable après mise à jour');

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_COMPLETED, {
      event: AdminNotificationEvent.APPLICATION_COMPLETED,
      title: 'Travail terminé',
      message: `Le travail de ${application.worker.first_name} ${application.worker.last_name} pour l'offre "${application.job_offer.title}" a été marqué comme terminé`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    // Fire-and-forget: send rating requests to both parties via WhatsApp
    this.sendRatingRequests(applicationId, application).catch(() => {});

    return updated;
  }

  private async sendRatingRequests(
    applicationId: string,
    application: { worker: { id: string; phone: string; first_name: string; last_name: string }; job_offer: { title: string; employer_id: string } },
  ): Promise<void> {
    const assignment = await this.prisma.assignment.findUnique({
      where: { application_id: applicationId },
      select: { id: true },
    });
    if (!assignment) return;

    const employer = await this.prisma.profile.findUnique({
      where: { id: application.job_offer.employer_id },
      select: { id: true, phone: true, first_name: true, last_name: true, whatsapp_connected: true },
    });

    const jobTitle = application.job_offer.title;
    const assignmentId = assignment.id;

    // Ask worker to rate employer
    if (application.worker.phone) {
      await this.botNotification.sendRatingRequest({
        raterProfileId: application.worker.id,
        raterPhone: application.worker.phone,
        rateeId: application.job_offer.employer_id,
        assignmentId,
        rateeLabel: employer ? `${employer.first_name} ${employer.last_name}`.trim() : 'l\'employeur',
        jobTitle,
      }).catch(() => {});
    }

    // Ask employer to rate worker
    if (employer?.phone && employer.whatsapp_connected) {
      const workerLabel = `${application.worker.first_name} ${application.worker.last_name}`.trim();
      await this.botNotification.sendRatingRequest({
        raterProfileId: employer.id,
        raterPhone: employer.phone,
        rateeId: application.worker.id,
        assignmentId,
        rateeLabel: workerLabel,
        jobTitle,
      }).catch(() => {});
    }
  }

  /** Employer cancels accepted application: reopen job offer, cancel application */
  async cancelAcceptedByEmployer(
    applicationId: string,
    employerId: string,
  ): Promise<ApplicationWithOffer> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true, worker: true },
    });
    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.job_offer.employer_id !== employerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }
    if (application.status !== ApplicationStatus.ACCEPTED) {
      throw new BadRequestException(
        'Seule une candidature acceptée peut être annulée ici',
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason: "Annulée par l'employeur",
        },
      });
      const remainingAccepted = await tx.application.count({
        where: {
          job_offer_id: application.job_offer_id,
          status: ApplicationStatus.ACCEPTED,
          id: { not: applicationId },
        },
      });
      await tx.jobOffer.update({
        where: { id: application.job_offer_id },
        data: {
          status:
            remainingAccepted > 0
              ? JobOfferStatus.PARTIALLY_FILLED
              : JobOfferStatus.ACTIVE,
        },
      });
      await tx.assignment.updateMany({
        where: { application_id: applicationId },
        data: {
          status: AssignmentStatus.CANCELLED_BY_EMPLOYER,
          cancelled_at: now,
        },
      });
      // Deduct employer reliability score
      const employer = await tx.profile.findUnique({
        where: { id: employerId },
        select: { reliability_score: true },
      });
      const currentScore = employer?.reliability_score ?? 100;
      const newScore = Math.max(
        RELIABILITY_SCORE_MIN,
        currentScore - EMPLOYER_CANCEL_SCORE_DEDUCTION,
      );
      await tx.profile.update({
        where: { id: employerId },
        data: { reliability_score: newScore },
      });
    });

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Candidature introuvable après mise à jour');

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_CANCELLED, {
      event: AdminNotificationEvent.APPLICATION_CANCELLED,
      title: 'Candidature annulée par employeur',
      message: `La candidature de ${application.worker.first_name} ${application.worker.last_name} pour l'offre "${application.job_offer.title}" a été annulée par l'employeur`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  async markAsViewed(applicationId: string): Promise<void> {
    await this.prisma.application.updateMany({
      where: {
        id: applicationId,
        status: ApplicationStatus.PENDING,
      },
      data: {
        status: ApplicationStatus.VIEWED,
        viewed_at: new Date(),
      },
    });
  }

  /** Update worker billing_status based on current unpaid penalty count. Call within a tx or after writes. */
  private async syncBillingStatus(
    workerId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const unpaidCount = await db.penalty.count({
      where: { worker_id: workerId, paid_at: null },
    });
    let newStatus: BillingStatus;
    if (unpaidCount === 0) {
      newStatus = BillingStatus.CLEAR;
    } else if (unpaidCount >= BILLING_BLOCK_THRESHOLD) {
      newStatus = BillingStatus.BLOCKED;
    } else {
      newStatus = BillingStatus.PENDING_PAYMENT;
    }
    await db.profile.update({
      where: { id: workerId },
      data: { billing_status: newStatus },
    });
  }

  async getUnpaidPenalties(
    workerId: string,
  ): Promise<{ count: number; total: number; ids: string[] }> {
    const penalties = await this.prisma.penalty.findMany({
      where: { worker_id: workerId, paid_at: null },
      select: { id: true, amount: true },
    });
    return {
      count: penalties.length,
      total: penalties.reduce((sum, p) => sum + Number(p.amount), 0),
      ids: penalties.map((p) => p.id),
    };
  }

  async markPenaltiesPaid(
    workerId: string,
  ): Promise<{ paidCount: number; totalAmount: number }> {
    const unpaid = await this.getUnpaidPenalties(workerId);
    if (unpaid.count === 0) {
      return { paidCount: 0, totalAmount: 0 };
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.penalty.updateMany({
        where: { worker_id: workerId, paid_at: null },
        data: { paid_at: now },
      }),
    ]);
    await this.syncBillingStatus(workerId);
    return { paidCount: unpaid.count, totalAmount: unpaid.total };
  }

  /** Get applications with ACCEPTED status and scheduled_at in the given time window (for reminders) */
  async findAcceptedInTimeWindow(
    windowStart: Date,
    windowEnd: Date,
  ): Promise<ApplicationWithOffer[]> {
    const applications = await this.prisma.application.findMany({
      where: {
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          scheduled_at: {
            gte: windowStart,
            lte: windowEnd,
          },
        },
      },
      include: {
        job_offer: {
          include: {
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                phone: true,
              },
            },
          },
        },
        worker: true,
      },
    });
    return applications.map((a) => this.toApplicationWithOffer(a));
  }

  async getApplicationDetailForAdmin(
    id: string,
  ): Promise<AdminApplicationDetailResponse> {
    const app = await this.prisma.application.findUnique({
      where: { id },
      include: {
        worker: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            avatar_url: true,
            reliability_score: true,
          },
        },
        job_offer: {
          select: {
            id: true,
            title: true,
            scheduled_at: true,
            amount: true,
            address: true,
            payment_flow: true,
            status: true,
            quantity: true,
            employer_id: true,
            employer: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
                phone: true,
                avatar_url: true,
              },
            },
          },
        },
        penalties: {
          orderBy: { created_at: 'desc' },
        },
        assignment: {
          select: { note: true },
        },
        contract: {
          select: { id: true },
        },
      },
    });

    if (!app) {
      throw new NotFoundException('Candidature introuvable');
    }

    return {
      id: app.id,
      jobTitle: app.job_offer.title,
      jobOfferId: app.job_offer_id,
      jobScheduledAt: app.job_offer.scheduled_at.toISOString(),
      jobAmount: Number(app.job_offer.amount),
      jobAddress: app.job_offer.address,
      jobPaymentFlow: app.job_offer.payment_flow,
      jobStatus: app.job_offer.status,
      jobQuantity: app.job_offer.quantity,
      workerName:
        `${app.worker.first_name ?? ''} ${app.worker.last_name ?? ''}`.trim() ||
        '—',
      workerEmail: app.worker.email,
      workerPhone: app.worker.phone,
      workerAvatarUrl: app.worker.avatar_url ?? null,
      workerId: app.worker_id,
      workerReliabilityScore: app.worker.reliability_score
        ? Number(app.worker.reliability_score)
        : null,
      employerName:
        `${app.job_offer.employer?.first_name ?? ''} ${app.job_offer.employer?.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: app.job_offer.employer?.email ?? '',
      employerPhone: app.job_offer.employer?.phone ?? '',
      employerAvatarUrl: app.job_offer.employer?.avatar_url ?? null,
      employerId: app.job_offer.employer_id,
      status: app.status,
      penaltyApplied: app.penalty_applied,
      penaltyAmount:
        app.penalty_amount != null ? Number(app.penalty_amount) : null,
      cancelledAt: app.cancelled_at?.toISOString() ?? null,
      cancellationReason: app.cancellation_reason,
      createdAt: app.created_at.toISOString(),
      updatedAt: app.updated_at.toISOString(),
      penalties: app.penalties.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        reason: p.reason,
        appliedAt: p.applied_at.toISOString(),
        paidAt: p.paid_at?.toISOString() ?? null,
      })),
      completionNote: (app as any).assignment?.note ?? null,
      contractId: (app as any).contract?.id ?? null,
    };
  }

  async getApplicationsForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: ApplicationStatus[];
    penaltyApplied?: string[];
  }): Promise<{
    data: AdminApplicationListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, status, penaltyApplied } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.ApplicationWhereInput = {};

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
          job_offer: {
            title: { contains: searchTrimmed, mode: 'insensitive' },
          },
        },
      ];
    }

    if (status != null && status.length > 0) {
      where.status = { in: status };
    }
    if (penaltyApplied && penaltyApplied.length > 0) {
      const boolValues = penaltyApplied.map((v) => v === 'true');
      if (boolValues.length === 1) {
        where.penalty_applied = boolValues[0];
      }
    }

    const [applications, total] = await Promise.all([
      this.prisma.application.findMany({
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
          job_offer: {
            select: {
              id: true,
              title: true,
              employer_id: true,
              employer: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.application.count({ where }),
    ]);

    const data: AdminApplicationListItem[] = applications.map((a) => ({
      id: a.id,
      jobTitle: a.job_offer.title,
      jobOfferId: a.job_offer_id,
      workerName:
        `${a.worker.first_name ?? ''} ${a.worker.last_name ?? ''}`.trim() ||
        '—',
      workerEmail: a.worker.email,
      workerPhone: a.worker.phone,
      workerAvatarUrl: a.worker.avatar_url ?? null,
      workerId: a.worker_id,
      employerName:
        `${a.job_offer.employer?.first_name ?? ''} ${a.job_offer.employer?.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: a.job_offer.employer?.email ?? '',
      employerAvatarUrl: a.job_offer.employer?.avatar_url ?? null,
      employerId: a.job_offer.employer_id,
      status: a.status,
      penaltyApplied: a.penalty_applied,
      penaltyAmount: a.penalty_amount == null ? null : Number(a.penalty_amount),
      cancelledAt: a.cancelled_at?.toISOString() ?? null,
      cancellationReason: a.cancellation_reason,
      createdAt: a.created_at.toISOString(),
      updatedAt: a.updated_at.toISOString(),
    }));

    return { data, total, page, limit };
  }

  private toListItem(app: {
    id: string;
    job_offer_id: string;
    worker_id: string;
    status: string;
    cancelled_at: Date | null;
    cancellation_reason: string | null;
    penalty_applied: boolean;
    penalty_amount: unknown;
    created_at: Date;
    job_offer?: {
      id: string;
      title: string;
      scheduled_at: Date;
      amount: unknown;
      address: string;
      status: string;
      employer_id: string;
    };
  }): ApplicationListItem {
    const item: ApplicationListItem = {
      id: app.id,
      job_offer_id: app.job_offer_id,
      worker_id: app.worker_id,
      status: app.status,
      cancelled_at: app.cancelled_at,
      cancellation_reason: app.cancellation_reason,
      penalty_applied: app.penalty_applied,
      penalty_amount:
        app.penalty_amount == null ? null : Number(app.penalty_amount),
      created_at: app.created_at,
    };
    if (app.job_offer) {
      item.job_offer = {
        id: app.job_offer.id,
        title: app.job_offer.title,
        scheduled_at: app.job_offer.scheduled_at,
        amount: Number(app.job_offer.amount),
        address: app.job_offer.address,
        status: app.job_offer.status,
        employer_id: app.job_offer.employer_id,
      };
    }
    return item;
  }

  private toApplicationWithOffer(app: {
    id: string;
    job_offer_id: string;
    worker_id: string;
    status: string;
    cancelled_at: Date | null;
    cancellation_reason: string | null;
    penalty_applied: boolean;
    penalty_amount: unknown;
    created_at: Date;
    job_offer: {
      id: string;
      title: string;
      description: string;
      scheduled_at: Date;
      amount: unknown;
      payment_flow: string;
      address: string;
      note: string | null;
      status: string;
      employer_id: string;
      employer?: {
        id: string;
        first_name: string;
        last_name: string;
        phone: string;
      };
    };
    worker: {
      id: string;
      first_name: string;
      last_name: string;
      phone: string;
      email: string;
      description: string;
      reliability_score: number | null;
      verification_status: string;
      avatar_url?: string | null;
    };
  }): ApplicationWithOffer {
    return {
      ...this.toListItem({ ...app, job_offer: app.job_offer }),
      job_offer: {
        id: app.job_offer.id,
        title: app.job_offer.title,
        description: app.job_offer.description,
        scheduled_at: app.job_offer.scheduled_at,
        amount: Number(app.job_offer.amount),
        payment_flow: app.job_offer.payment_flow,
        address: app.job_offer.address,
        note: app.job_offer.note,
        status: app.job_offer.status,
        employer_id: app.job_offer.employer_id,
        employer: app.job_offer.employer,
      },
      worker: app.worker,
    } as ApplicationWithOffer;
  }
}
