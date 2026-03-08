import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AccountStatus,
  ApplicationStatus,
  JobOfferStatus,
  PaymentStatus,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import {
  LATE_CANCELLATION_PENALTY_FCFA,
  LATE_CANCELLATION_SCORE_DEDUCTION,
  CANCELLATION_PENALTY_THRESHOLD_HOURS,
  RELIABILITY_SCORE_MIN,
  RELIABILITY_SCORE_MAX,
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
  constructor(private readonly prisma: PrismaService) {}

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
        'Vous avez des pénalités impayées. Réglez-les pour pouvoir postuler aux offres.',
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

    return this.toListItem(application);
  }

  async findByWorker(
    workerId: string,
    options?: { status?: ApplicationStatus; limit?: number },
  ): Promise<ApplicationWithOffer[]> {
    const limit = options?.limit ?? 50;
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
    if (application.status !== ApplicationStatus.PENDING) {
      throw new BadRequestException("Cette candidature n'est plus en attente");
    }

    const currentAcceptedCount = await this.prisma.application.count({
      where: {
        job_offer_id: application.job_offer_id,
        status: ApplicationStatus.ACCEPTED,
      },
    });

    const quantityNeeded = application.job_offer.quantity ?? 1;
    const shouldFillJob = currentAcceptedCount + 1 >= quantityNeeded;

    await this.prisma.$transaction([
      this.prisma.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.ACCEPTED },
      }),
      this.prisma.jobOffer.update({
        where: { id: application.job_offer_id },
        data: {
          status: shouldFillJob ? JobOfferStatus.FILLED : JobOfferStatus.ACTIVE,
        },
      }),
    ]);

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Application not found after update');
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
    if (application.status !== ApplicationStatus.PENDING) {
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

    let penaltyApplied = false;
    let penaltyAmount: number | null = null;

    if (application.status === ApplicationStatus.ACCEPTED) {
      await this.prisma.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: JobOfferStatus.ACTIVE },
      });
    }

    if (
      isLateCancellation &&
      application.status === ApplicationStatus.ACCEPTED
    ) {
      penaltyApplied = true;
      penaltyAmount = LATE_CANCELLATION_PENALTY_FCFA;

      await this.prisma.penalty.create({
        data: {
          worker_id: workerId,
          application_id: applicationId,
          amount: LATE_CANCELLATION_PENALTY_FCFA,
          reason:
            reason ??
            `Annulation tardive (< ${CANCELLATION_PENALTY_THRESHOLD_HOURS}h avant le rendez-vous)`,
        },
      });

      const profile = await this.prisma.profile.findUnique({
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
      await this.prisma.profile.update({
        where: { id: workerId },
        data: { reliability_score: newScore },
      });
    }

    const updated = await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.CANCELLED,
        cancelled_at: now,
        cancellation_reason: reason ?? null,
        penalty_applied: penaltyApplied,
        penalty_amount: penaltyAmount,
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

    return {
      application: this.toApplicationWithOffer(updated),
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
    if (!app || app.worker_id !== workerId) return false;
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
        'Seule une candidature acceptée peut être marquée comme terminée',
      );
    }
    if (application.job_offer.status === JobOfferStatus.COMPLETED) {
      throw new BadRequestException(
        'Cette mission est déjà marquée comme terminée',
      );
    }

    const amount = Number(application.job_offer.amount);
    const transactionId = generatePaymentReference();
    await this.prisma.$transaction([
      this.prisma.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: JobOfferStatus.COMPLETED },
      }),
      this.prisma.payment.create({
        data: {
          profile_id: application.worker_id,
          amount,
          payment_method: PaymentMethod.OTHER,
          transaction_id: transactionId,
          status: PaymentStatus.COMPLETED,
          completed_at: new Date(),
        },
      }),
    ]);

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Application not found after update');
    return updated;
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
    await this.prisma.$transaction([
      this.prisma.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason: "Annulée par l'employeur",
        },
      }),
      this.prisma.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: JobOfferStatus.ACTIVE },
      }),
    ]);

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Application not found after update');
    return updated;
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
      penaltyAmount:
        a.penalty_amount != null ? Number(a.penalty_amount) : null,
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
        app.penalty_amount != null ? Number(app.penalty_amount) : null,
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
