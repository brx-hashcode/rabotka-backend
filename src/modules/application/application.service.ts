import {
  AdminCacheService,
  ADMIN_LIST_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';
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
import { jobLocationLabel } from '../../common/utils/job-location.util';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { assertKycVerified } from '../../common/exceptions/kyc-not-verified.exception';
import { deletedAtFilter } from '../../common/utils/soft-delete.util';
import {
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../../common/utils/business-day.util';
import { InteractionEventService } from '../recommendation-engine/interaction-event.service';
import { JobEventsGateway } from '../ws-notifications/job-events.gateway';
import { isWorkerHardBlocked } from '../penalty/penalty.utils';
import { closesOnFill } from '../job-offer/utils/employment-type.util';
import { isTerminalJobOfferStatus } from '../job-offer/utils/job-offer-status.util';
import { closeRecruitedOfferTx } from '../job-offer/utils/close-recruited-offer';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import {
  AccountStatus,
  ApplicationStatus,
  AssignmentStatus,
  BillingStatus,
  EmploymentType,
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  JobOfferStatus,
  Prisma,
  RatingDirection,
  RejectionSource,
} from '@prisma/client';
import { ContractService } from '../contract/contract.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { MatchingService } from '../matching/matching.service';
import {
  RELIABILITY_SCORE_MAX,
  PENALTY_SUSPENSION_THRESHOLD,
} from './application.constants';

/**
 * Statuses that count as a worker's "active" candidature — i.e. the worker
 * is still tracking it (could still result in money or having to show up at
 * a job site). Used both for the concurrent-applications quota and for the
 * worker's "Mes candidatures" bot list.
 */
export const WORKER_ACTIVE_APPLICATION_STATUSES = [
  ApplicationStatus.PENDING,
  ApplicationStatus.ACCEPTED,
] as const;

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
  /** Null for an offer with no closing date — CDI/CDD/STAGE. */
  jobScheduledAt: string | null;
  jobAmount: number;
  jobAddress: string;
  jobPaymentFlow: string | null;
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
    scheduled_at: Date | null;
    amount: number;
    address: string | null;
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
    scheduled_at: Date | null;
    /** Decides whether `scheduled_at` is a start time or a closing deadline,
        and whether END means "work finished" or "we were hired". */
    employment_type: EmploymentType | null;
    amount: number | null;
    payment_flow: string | null;
    address: string | null;
    /** Address alone cannot say "remote", and a blank line is what the
        applications list rendered for every remote offer. */
    is_remote: boolean;
    city: string | null;
    country_name: string | null;
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
  contractId?: string | null;
  /**
   * Whether the EMPLOYER has already rated this worker.
   *
   * Mirrors `ratedEmployer` on the worker's own mission card. Only populated by
   * `findByJobOffer`, which is what the employer's offer detail reads — without
   * it the "Noter le travailleur" button has nothing to disappear on, so a
   * rating leaves the screen looking exactly as it did before.
   */
  ratedByEmployer?: boolean;
};

const WORKER_MISSION_SELECT = {
  id: true,
  status: true,
  assignment: { select: { id: true, status: true } },
  contract: { select: { id: true } },
  job_offer: {
    select: {
      id: true,
      title: true,
      description: true,
      scheduled_at: true,
      // The worker's mission screen gates "Terminer & noter" on this: only a
      // MISSION can be completed. Unselected, it arrived undefined and the
      // client's `?? MISSION` default showed the button on every CDI, where the
      // API then rejected it.
      employment_type: true,
      amount: true,
      address: true,
      // The rest of the location. Without these the worker's mission screen had
      // nothing to fall back on when `address` was null, so every remote job —
      // and every offer posted before the address field existed — rendered
      // "Lieu non précisé", including ones whose city we knew perfectly well.
      is_remote: true,
      city: true,
      country_name: true,
      // Where the employer writes the practical detail: meeting point, what to
      // bring, who to ask for. It reached this screen and was dropped.
      note: true,
      status: true,
      employer: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          reliability_score: true,
          // The mission screen renders an employer avatar and had no URL to put
          // in it, so it always fell through to the initials.
          avatar_url: true,
          rating_avg: true,
          rating_count: true,
        },
      },
    },
  },
} satisfies Prisma.ApplicationSelect;

type WorkerMissionRow = Prisma.ApplicationGetPayload<{
  select: typeof WORKER_MISSION_SELECT;
}>;

export type WorkerMissionCard = {
  applicationId: string;
  applicationStatus: ApplicationStatus;
  assignmentStatus: AssignmentStatus | null;
  ratedEmployer: boolean;
  contractId: string | null;
  jobOffer: {
    id: string;
    title: string;
    description: string;
    /** Null for an offer with no closing date — CDI/CDD/STAGE. */
    scheduledAt: string | null;
    employmentType: EmploymentType;
    amount: number | null;
    /** Null for a remote job, and for offers predating the address field. */
    address: string | null;
    isRemote: boolean;
    city: string | null;
    countryName: string | null;
    /** The employer's free-text practical instructions. */
    note: string | null;
    status: JobOfferStatus;
  };
  employer: {
    id: string;
    firstName: string;
    lastName: string;
    reliabilityScore: number | null;
    avatarUrl: string | null;
    ratingAvg: number | null;
    ratingCount: number;
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
    private readonly systemConfigService: SystemConfigService,
    private readonly matchingService: MatchingService,
    private readonly interactionEvents: InteractionEventService,
    private readonly cache: AdminCacheService,
    @Inject(forwardRef(() => JobEventsGateway))
    private readonly jobEvents: JobEventsGateway,
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
        select: {
          id: true,
          status: true,
          profile_type: true,
          verification_status: true,
        },
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
    // Also checked by KycVerifiedGuard on the HTTP route. Repeated here because
    // the WhatsApp bot calls this service directly (apply-job.flow.ts), where no
    // guard runs.
    assertKycVerified(worker.verification_status);
    if (
      jobOffer.status !== JobOfferStatus.ACTIVE &&
      jobOffer.status !== JobOfferStatus.PARTIALLY_FILLED
    ) {
      throw new BadRequestException("Cette offre n'est plus disponible");
    }
    if (jobOffer.employer_id === workerId) {
      throw new BadRequestException(
        'Vous ne pouvez pas postuler à votre propre offre',
      );
    }

    const unpaidPenaltiesCount = await this.prisma.penalty.count({
      where: {
        profile_id: workerId,
        paid_at: null,
      },
    });
    if (unpaidPenaltiesCount > 0) {
      const hardBlocked = await isWorkerHardBlocked(this.prisma, workerId);
      if (hardBlocked) {
        throw new ForbiddenException(
          '🚨 Votre compte est bloqué en raison de pénalités impayées depuis plus de 3 jours. Veuillez les payer afin de pouvoir postuler à nouveau.',
        );
      }
      throw new ForbiddenException(
        'Vous avez des pénalités impayées. Veuillez les payer afin de pouvoir postuler à nouveau.',
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

    const fees = await this.systemConfigService.getFees();

    // The daily cap is now the ONLY gate on applying. There used to be a
    // concurrent-slot cap alongside it, and it was the binding one — 5 slots
    // against 10/day — which meant a worker with five pending applications was
    // blocked indefinitely: the daily window rolls at midnight, open slots do
    // not. They only free when an employer responds, so the worker was left
    // waiting on someone else with a UI that said "0 remaining, resets at
    // midnight".
    //
    // A sliding window, not a stored counter: nothing resets it, the midnight
    // boundary simply moves. Enforced for both the WhatsApp bot and the mobile
    // apply endpoint.
    const todayCount = await this.countApplicationsToday(workerId);
    if (todayCount >= fees.maxDailyApplications) {
      throw new ForbiddenException(
        `Vous avez atteint votre limite de ${fees.maxDailyApplications} candidatures aujourd'hui. Réessayez demain.`,
      );
    }

    const application = await this.prisma.$transaction(async (tx) => {
      // Lock the job offer row so a concurrent accept() cannot fill remaining
      // slots between our status check above and this create.
      await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${jobOfferId}::uuid FOR UPDATE`;
      const freshOffer = await tx.jobOffer.findUnique({
        where: { id: jobOfferId },
        select: { status: true },
      });
      if (
        freshOffer?.status !== JobOfferStatus.ACTIVE &&
        freshOffer?.status !== JobOfferStatus.PARTIALLY_FILLED
      ) {
        throw new BadRequestException("Cette offre n'est plus disponible");
      }
      return tx.application.create({
        data: {
          job_offer_id: jobOfferId,
          worker_id: workerId,
          status: ApplicationStatus.PENDING,
        },
        include: { job_offer: true },
      });
    });

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_CREATED, {
      event: AdminNotificationEvent.APPLICATION_CREATED,
      title: 'Nouvelle candidature',
      message: `Nouvelle candidature pour l'offre "${application.job_offer.title}"`,
      entityType: 'application',
      entityId: String(application.id),
      timestamp: new Date().toISOString(),
    });

    // Captured server-side rather than from the client so it can't be inflated,
    // and so the WhatsApp bot and the web app produce the same signal.
    void this.interactionEvents.record({
      actorId: workerId,
      actorType: InteractionActor.WORKER,
      kind: InteractionKind.APPLY,
      objectType: InteractionObject.JOB_OFFER,
      objectId: jobOfferId,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer.employer_id,
      source: InteractionSource.SERVER,
      surface: 'apply',
    });

    // Notify the employer here, not at the call site: this used to fire only
    // from the WhatsApp apply flow, so a worker applying on the web produced no
    // notification at all. Fire-and-forget — a WhatsApp failure must never fail
    // the application itself.
    void this.botNotification
      .sendNewApplicationToEmployer(application.id)
      .catch((err: unknown) =>
        console.warn(
          `[create] new-application notify failed for ${application.id}:`,
          err,
        ),
      );

    return this.toListItem(application);
  }

  private buildApplicationListWhere(args: {
    workerId?: string;
    employerId?: string;
    status?: ApplicationStatus;
    statusIn?: readonly ApplicationStatus[];
  }): Prisma.ApplicationWhereInput {
    const where: Prisma.ApplicationWhereInput = {};
    if (args.workerId) where.worker_id = args.workerId;
    if (args.employerId) where.job_offer = { employer_id: args.employerId };
    if (args.status) {
      where.status = args.status;
    } else if (args.statusIn && args.statusIn.length > 0) {
      where.status = { in: [...args.statusIn] };
    }
    return where;
  }

  private applicationListInclude(): Prisma.ApplicationInclude {
    return {
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
    };
  }

  // Existing limit-based call shape: returns a flat array.
  async findByWorker(
    workerId: string,
    options?: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      limit?: number;
    },
  ): Promise<ApplicationWithOffer[]>;
  // New paginated call shape: returns { items, total } for bot pagination.
  async findByWorker(
    workerId: string,
    options: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      page: number;
      pageSize: number;
    },
  ): Promise<{ items: ApplicationWithOffer[]; total: number }>;
  async findByWorker(
    workerId: string,
    options?: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      limit?: number;
      page?: number;
      pageSize?: number;
    },
  ): Promise<
    ApplicationWithOffer[] | { items: ApplicationWithOffer[]; total: number }
  > {
    const where = this.buildApplicationListWhere({
      workerId,
      status: options?.status,
      statusIn: options?.statusIn,
    });

    if (options?.page !== undefined && options?.pageSize !== undefined) {
      const pageSize = Math.min(options.pageSize, 100);
      const [rows, total] = await Promise.all([
        this.prisma.application.findMany({
          where,
          skip: options.page * pageSize,
          take: pageSize,
          orderBy: { created_at: 'desc' },
          include: this.applicationListInclude(),
        }),
        this.prisma.application.count({ where }),
      ]);
      return {
        items: rows.map((a) => this.toApplicationWithOffer(a)),
        total,
      };
    }

    const limit = Math.min(options?.limit ?? 50, 100);
    const applications = await this.prisma.application.findMany({
      where,
      take: limit,
      orderBy: { created_at: 'desc' },
      include: this.applicationListInclude(),
    });

    return applications.map((a) => this.toApplicationWithOffer(a));
  }

  async findByEmployer(
    employerId: string,
    options?: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      limit?: number;
    },
  ): Promise<ApplicationWithOffer[]>;
  async findByEmployer(
    employerId: string,
    options: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      page: number;
      pageSize: number;
    },
  ): Promise<{ items: ApplicationWithOffer[]; total: number }>;
  async findByEmployer(
    employerId: string,
    options?: {
      status?: ApplicationStatus;
      statusIn?: readonly ApplicationStatus[];
      limit?: number;
      page?: number;
      pageSize?: number;
    },
  ): Promise<
    ApplicationWithOffer[] | { items: ApplicationWithOffer[]; total: number }
  > {
    const where = this.buildApplicationListWhere({
      employerId,
      status: options?.status,
      statusIn: options?.statusIn,
    });

    if (options?.page !== undefined && options?.pageSize !== undefined) {
      const pageSize = Math.min(options.pageSize, 100);
      const [rows, total] = await Promise.all([
        this.prisma.application.findMany({
          where,
          skip: options.page * pageSize,
          take: pageSize,
          orderBy: { created_at: 'desc' },
          include: this.applicationListInclude(),
        }),
        this.prisma.application.count({ where }),
      ]);
      return {
        items: rows.map((a) => this.toApplicationWithOffer(a)),
        total,
      };
    }

    const limit = Math.min(options?.limit ?? 50, 100);
    const applications = await this.prisma.application.findMany({
      where,
      take: limit,
      orderBy: { created_at: 'desc' },
      include: this.applicationListInclude(),
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
        contract: { select: { id: true } },
        assignment: { select: { id: true } },
      },
    });

    // Which of these the employer has already rated. One batched query rather
    // than one per row; empty when nothing is rateable yet.
    const assignmentIds = applications
      .map((a) => a.assignment?.id)
      .filter((id): id is string => !!id);
    const employerId = applications[0]?.job_offer.employer_id;
    const ratedAssignmentIds = new Set(
      assignmentIds.length === 0 || !employerId
        ? []
        : (
            await this.prisma.rating.findMany({
              where: {
                rater_id: employerId,
                assignment_id: { in: assignmentIds },
              },
              select: { assignment_id: true },
            })
          ).map((r) => r.assignment_id),
    );

    return applications.map((a) => ({
      ...this.toApplicationWithOffer(a),
      ratedByEmployer: a.assignment
        ? ratedAssignmentIds.has(a.assignment.id)
        : false,
    }));
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

    const fees = await this.systemConfigService.getFees();
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { reliability_score: true },
    });
    const employerScore = employer?.reliability_score ?? 100;
    if (employerScore <= fees.reliabilityScoreMin) {
      throw new ForbiddenException(
        'Votre compte est pénalisé. Vous ne pouvez pas accepter de candidatures pour le moment.',
      );
    }

    if (
      application.status !== ApplicationStatus.PENDING &&
      application.status !== ApplicationStatus.VIEWED
    ) {
      throw new BadRequestException("Cette candidature n'est plus en attente");
    }

    let autoRejectedIds: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      // Lock the application row first to prevent concurrent duplicate-accept
      await tx.$executeRaw`SELECT id FROM "applications" WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const freshApp = await tx.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      if (
        freshApp?.status !== ApplicationStatus.PENDING &&
        freshApp?.status !== ApplicationStatus.VIEWED
      ) {
        throw new BadRequestException(
          "Cette candidature n'est plus en attente",
        );
      }

      // Lock the job offer row to prevent concurrent over-acceptance
      await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${application.job_offer_id}::uuid FOR UPDATE`;

      const currentAcceptedCount = await tx.application.count({
        where: {
          job_offer_id: application.job_offer_id,
          status: {
            in: [
              ApplicationStatus.ACCEPTED,
              'WAITING_PAYMENT' as ApplicationStatus,
            ],
          },
        },
      });

      const quantityNeeded = application.job_offer.quantity ?? 1;
      if (currentAcceptedCount >= quantityNeeded) {
        throw new ConflictException(
          'Cette offre a déjà atteint sa capacité maximale de candidats acceptés',
        );
      }

      const newAcceptedCount = currentAcceptedCount + 1;
      let offerStatus: JobOfferStatus;
      if (newAcceptedCount >= quantityNeeded) {
        offerStatus = JobOfferStatus.FILLED;
      } else {
        offerStatus = JobOfferStatus.PARTIALLY_FILLED;
      }

      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.WAITING_PAYMENT,
          // `updated_at` is overwritten by every later transition, so the
          // decision moment needs its own column.
          accepted_at: new Date(),
        },
      });
      await tx.jobOffer.update({
        where: { id: application.job_offer_id },
        data: { status: offerStatus },
      });
      await tx.assignment.create({
        data: {
          application_id: applicationId,
          job_offer_id: application.job_offer_id,
          worker_id: application.worker_id,
          status: AssignmentStatus.CONFIRMED,
        },
      });
      await this.contactUnlock.initiateUnlock(applicationId, employerId, tx);

      if (offerStatus === JobOfferStatus.FILLED) {
        const toAutoReject = await tx.application.findMany({
          where: {
            job_offer_id: application.job_offer_id,
            id: { not: applicationId },
            status: {
              in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED],
            },
          },
          select: { id: true },
        });
        autoRejectedIds = toAutoReject.map((a) => a.id);

        if (autoRejectedIds.length > 0) {
          await tx.application.updateMany({
            where: { id: { in: autoRejectedIds } },
            data: {
              status: ApplicationStatus.REJECTED,
              rejected_at: new Date(),
              // The offer filled up — nobody judged these workers. Marking them
              // AUTO_FILL keeps them out of negative preference signals; without
              // it, losing two races looks identical to being turned down twice.
              rejection_source: RejectionSource.AUTO_FILL,
            },
          });
        }
      }
    });

    for (const appId of autoRejectedIds) {
      this.botNotification
        .sendApplicationRejectedToWorker(appId)
        .catch((err: unknown) =>
          console.warn(`[accept] auto-reject notify failed for ${appId}:`, err),
        );
    }

    // The accepted worker was only ever notified from the WhatsApp accept flow,
    // so accepting on the web left them uninformed while their rivals got their
    // rejection. Fires here so both channels behave the same.
    void this.botNotification
      .sendApplicationAcceptedToWorker(applicationId)
      .catch((err: unknown) =>
        console.warn(
          `[accept] accepted notify failed for ${applicationId}:`,
          err,
        ),
      );

    const updated = await this.findById(applicationId);
    if (!updated)
      throw new NotFoundException('Candidature introuvable après mise à jour');

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
      .catch((err) =>
        console.warn(
          `Failed to create contract metadata for ${applicationId}:`,
          err,
        ),
      );

    // Accepting is the employer's strongest non-paid endorsement of a worker.
    void this.interactionEvents.record({
      actorId: employerId,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.ACCEPT,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: application.worker_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer_id,
      source: InteractionSource.SERVER,
      surface: 'application_accept',
    });

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
      data: {
        status: ApplicationStatus.REJECTED,
        rejected_at: new Date(),
        // An actual employer decision — distinct from AUTO_FILL, which is what
        // rejectPendingApplicants writes when an offer simply fills up. Only this
        // variant may ever be read as a negative preference signal.
        rejection_source: RejectionSource.EMPLOYER,
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

    void this.interactionEvents.record({
      actorId: employerId,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.REJECT,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: application.worker_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer_id,
      source: InteractionSource.SERVER,
      surface: 'application_reject',
      metadata: reason ? { reason } : undefined,
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
    // END is cancellable only on an ongoing engagement, where it does not mean
    // "the work is finished" but "the offer closed once we were hired". A hire
    // that falls through — the worker never starts, the employer changes their
    // mind — has to be reversible, or closing the offer would turn a permanent
    // job into a permanent bond. On a MISSION, END really does mean finished
    // and there is nothing to walk away from.
    const isReversibleHire =
      application.status === ApplicationStatus.END &&
      closesOnFill(application.job_offer.employment_type);

    if (
      application.status !== ApplicationStatus.ACCEPTED &&
      application.status !== ApplicationStatus.PENDING &&
      application.status !== ('WAITING_PAYMENT' as ApplicationStatus) &&
      !isReversibleHire
    ) {
      throw new BadRequestException(
        'Cette candidature ne peut plus être annulée',
      );
    }

    const now = new Date();
    const scheduledAt = application.job_offer.scheduled_at;

    // Block cancellation after the job has already started. An offer with no
    // closing date has not "already started" — there is no instant to be past.
    if (
      scheduledAt !== null &&
      scheduledAt <= now &&
      application.status === ApplicationStatus.ACCEPTED
    ) {
      throw new BadRequestException(
        'Cette mission a déjà débuté, vous ne pouvez plus annuler votre candidature',
      );
    }

    const fees = await this.systemConfigService.getFees();
    // No deadline means nothing to be late for. Penalising a worker against a
    // date that does not exist would be arbitrary, so an undated engagement is
    // always free to leave.
    const isLateCancellation =
      scheduledAt !== null &&
      (scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000) <
        fees.cancellationThresholdHours;
    const isAccepted = application.status === ApplicationStatus.ACCEPTED;
    const isWaitingPayment =
      application.status === ('WAITING_PAYMENT' as ApplicationStatus);
    // Penalty applies for late cancellation on ACCEPTED or WAITING_PAYMENT (worker already committed)
    const applyPenalty = isLateCancellation && (isAccepted || isWaitingPayment);

    const penaltyApplied = applyPenalty;
    const penaltyAmount: number | null = applyPenalty
      ? fees.lateCancellationPenaltyFcfa
      : null;

    await this.prisma.$transaction(async (tx) => {
      // Lock and re-check the application status inside the transaction to
      // prevent a concurrent/duplicate cancel from deducting the reliability
      // score twice (the penalty upsert is idempotent, the deduction is not).
      await tx.$executeRaw`SELECT id FROM "applications" WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const fresh = await tx.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      if (fresh?.status === ApplicationStatus.CANCELLED) {
        throw new BadRequestException('Cette candidature est déjà annulée');
      }

      if (isAccepted || isWaitingPayment || isReversibleHire) {
        // Which slots are still taken, this application aside. On an undone
        // hire the other hires sit at END rather than ACCEPTED — the offer
        // closed around them — so counting only ACCEPTED/WAITING_PAYMENT would
        // read a fully staffed team as empty and throw the offer wide open.
        const remainingAccepted = await tx.application.count({
          where: {
            job_offer_id: application.job_offer_id,
            status: {
              in: isReversibleHire
                ? [
                    ApplicationStatus.ACCEPTED,
                    'WAITING_PAYMENT' as ApplicationStatus,
                    ApplicationStatus.END,
                  ]
                : [
                    ApplicationStatus.ACCEPTED,
                    'WAITING_PAYMENT' as ApplicationStatus,
                  ],
            },
            id: { not: applicationId },
          },
        });
        const reopenStatus =
          remainingAccepted > 0
            ? JobOfferStatus.PARTIALLY_FILLED
            : JobOfferStatus.ACTIVE;
        if (isReversibleHire) {
          // Deliberately bypasses the terminal guard. Undoing the hire is the
          // one legitimate route back out of COMPLETED — the offer was closed
          // *because* this person took the job, and they no longer have.
          await tx.jobOffer.update({
            where: { id: application.job_offer_id },
            data: { status: reopenStatus },
          });
        } else {
          await this.reopenOfferUnlessClosed(
            tx,
            application.job_offer_id,
            reopenStatus,
          );
        }
        await tx.assignment.updateMany({
          where: { application_id: applicationId },
          data: {
            status: AssignmentStatus.CANCELLED_BY_WORKER,
            cancelled_at: now,
          },
        });
      }

      if (applyPenalty) {
        await tx.penalty.upsert({
          where: { application_id: applicationId },
          create: {
            profile_id: workerId,
            application_id: applicationId,
            amount: fees.lateCancellationPenaltyFcfa,
            reason:
              reason ??
              `Annulation tardive (< ${fees.cancellationThresholdHours}h avant le rendez-vous)`,
          },
          update: {},
        });

        const profile = await tx.profile.findUnique({
          where: { id: workerId },
          select: { reliability_score: true },
        });
        const currentScore = profile?.reliability_score ?? 100;
        const newScore = Math.max(
          fees.reliabilityScoreMin,
          Math.min(
            RELIABILITY_SCORE_MAX,
            currentScore - fees.lateCancellationScoreDeduction,
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

    // If WAITING_PAYMENT, abort the pending unlock attempt and refund any payment already made
    if (isWaitingPayment) {
      await this.contactUnlock
        .abortPendingUnlockByApplication(applicationId)
        .catch((err) =>
          console.warn(
            `[cancel] Failed to abort unlock for ${applicationId}:`,
            err,
          ),
        );
    }

    // Suspension check after penalty creation
    if (applyPenalty) {
      const unpaidCount = await this.prisma.penalty.count({
        where: { profile_id: workerId, paid_at: null },
      });
      if (unpaidCount >= PENALTY_SUSPENSION_THRESHOLD) {
        const total = unpaidCount * fees.lateCancellationPenaltyFcfa;
        const workerProfile = await this.prisma.profile.update({
          where: { id: workerId },
          data: {
            status: AccountStatus.SUSPENDED,
            // Same column the admin path writes, so the admin detail can answer
            // "why is this account suspended?" for automatic suspensions too.
            suspension_reason: `${unpaidCount} pénalités impayées (total : ${total.toLocaleString('fr-FR')} FCFA)`,
            suspended_at: new Date(),
          },
        });
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

    // The worker walked away from this offer — attributed to them, since the
    // employer did nothing here.
    void this.interactionEvents.record({
      actorId: workerId,
      actorType: InteractionActor.WORKER,
      kind: InteractionKind.APPLY_CANCEL,
      objectType: InteractionObject.JOB_OFFER,
      objectId: application.job_offer_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer.employer_id,
      source: InteractionSource.SERVER,
      surface: 'application_cancel',
    });

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
      app.status !== ApplicationStatus.PENDING &&
      app.status !== ('WAITING_PAYMENT' as ApplicationStatus)
    )
      return false;
    // Undated engagements carry no penalty — there is no deadline to miss.
    if (app.job_offer.scheduled_at === null) return false;
    const now = new Date();
    const hoursUntil =
      (app.job_offer.scheduled_at.getTime() - now.getTime()) / (60 * 60 * 1000);
    const fees = await this.systemConfigService.getFees();
    return hoursUntil >= 0 && hoursUntil < fees.cancellationThresholdHours;
  }

  /**
   * Reject the applicants left "hanging" when an offer reaches a terminal/closed
   * state (COMPLETED, CANCELLED, FILLED, …): flip every still-uncommitted
   * application (PENDING / VIEWED / WAITING_PAYMENT) to REJECTED. Mirrors the
   * auto-reject in `accept()`. Returns the rejected application ids so the caller
   * can notify the workers *after* its transaction commits (see
   * `notifyRejectedApplicants`).
   *
   * Idempotent by construction: REJECTED is terminal, so a leftover only matches
   * the filter once — re-running any transition rejects nothing (no double sends).
   *
   * @param tx  when supplied, the status write joins the caller's transaction so
   *            it commits atomically with the offer's own status change.
   */
  async rejectPendingApplicants(
    jobOfferId: string,
    opts?: {
      tx?: Prisma.TransactionClient;
      excludeApplicationId?: string;
    },
  ): Promise<string[]> {
    const client = opts?.tx ?? this.prisma;

    const leftovers = await client.application.findMany({
      where: {
        job_offer_id: jobOfferId,
        status: {
          in: [
            ApplicationStatus.PENDING,
            ApplicationStatus.VIEWED,
            ApplicationStatus.WAITING_PAYMENT,
          ],
        },
        ...(opts?.excludeApplicationId
          ? { id: { not: opts.excludeApplicationId } }
          : {}),
      },
      select: { id: true },
    });
    if (leftovers.length === 0) return [];

    const ids = leftovers.map((a) => a.id);
    await client.application.updateMany({
      where: { id: { in: ids } },
      data: {
        status: ApplicationStatus.REJECTED,
        rejected_at: new Date(),
        // Closed out because the offer is no longer open, not because the
        // employer rejected anyone. Must never count as a negative signal.
        rejection_source: RejectionSource.AUTO_FILL,
      },
    });
    return ids;
  }

  /**
   * Best-effort WhatsApp "your application was closed" fan-out for the ids
   * returned by `rejectPendingApplicants`. Each send is guarded so one failure
   * never aborts the loop. Call this *after* the caller's transaction commits.
   */
  notifyRejectedApplicants(applicationIds: string[]): void {
    for (const appId of applicationIds) {
      this.botNotification
        .sendApplicationRejectedToWorker(appId)
        .catch((err: unknown) =>
          console.warn(
            `[notifyRejectedApplicants] notify failed for ${appId}:`,
            err,
          ),
        );
    }
  }

  /**
   * Apply a 1–5 rating to a worker's reliability_score using the configured
   * per-star delta (`fees.ratingScoreDeltas`), clamped to
   * [reliabilityScoreMin, RELIABILITY_SCORE_MAX]. Runs inside the caller's
   * transaction. Only meaningful for a WORKER ratee — the caller must gate on
   * that (an employer's reliability is not driven by worker ratings today).
   *
   * Call this only for a *newly created* rating, never on re-rating, to avoid
   * applying the delta more than once for the same assignment.
   */
  async applyRatingToReliability(
    tx: Prisma.TransactionClient,
    workerProfileId: string,
    score: number,
  ): Promise<void> {
    const fees = await this.systemConfigService.getFees();
    const delta = fees.ratingScoreDeltas[score];
    if (delta === undefined || delta === 0) return;

    const worker = await tx.profile.findUnique({
      where: { id: workerProfileId },
      select: { reliability_score: true },
    });
    const currentScore = worker?.reliability_score ?? 100;
    const nextScore = Math.max(
      fees.reliabilityScoreMin,
      Math.min(RELIABILITY_SCORE_MAX, currentScore + delta),
    );
    if (nextScore !== currentScore) {
      await tx.profile.update({
        where: { id: workerProfileId },
        data: { reliability_score: nextScore },
      });
    }
  }

  /**
   * Settles the offer once every hired worker has confirmed their own side.
   *
   * Completion is the worker's call, not the employer's: the worker is the one
   * who knows the work is done. But an offer can hire several workers
   * (`quantity`), so the first one to finish must not end everyone else's
   * mission — the offer only closes when no hired worker is still outstanding.
   *
   * Runs inside the caller's transaction, after that worker's application has
   * been moved to END, and takes the job-offer row lock so two workers
   * confirming at once cannot both decide they were last.
   *
   * Returns the applicants rejected as a result, for post-commit notification.
   */
  private async closeOfferIfAllWorkersDone(
    tx: Prisma.TransactionClient,
    jobOfferId: string,
  ): Promise<string[]> {
    await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${jobOfferId}::uuid FOR UPDATE`;

    const freshOffer = await tx.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: { status: true },
    });
    if (freshOffer?.status === JobOfferStatus.COMPLETED) return [];

    // Anyone hired and not yet finished. NO_SHOW workers are not waited on —
    // they are never going to confirm.
    const stillWorking = await tx.application.count({
      where: {
        job_offer_id: jobOfferId,
        status: {
          in: [ApplicationStatus.ACCEPTED, ApplicationStatus.STARTED],
        },
        NOT: { assignment: { status: AssignmentStatus.NO_SHOW } },
      },
    });
    if (stillWorking > 0) return [];

    await tx.jobOffer.update({
      where: { id: jobOfferId },
      data: { status: JobOfferStatus.COMPLETED },
    });

    // Close out any applicants still waiting on this now-completed offer
    // (PENDING / VIEWED / WAITING_PAYMENT → REJECTED). Notified after commit.
    return this.rejectPendingApplicants(jobOfferId, { tx });
  }

  /**
   * Puts an offer back to recruiting after someone drops out — unless it has
   * already been closed for good.
   *
   * The guard is the point. Every caller here computes a reopen status from a
   * count and writes it unconditionally, which was safe while COMPLETED could
   * only arrive days later via every worker confirming. An ongoing engagement
   * now closes the instant its last position is paid for, so an unguarded write
   * can land on a closed offer and put a fully-staffed post back on the feed
   * with its workers already at END.
   */
  private async reopenOfferUnlessClosed(
    tx: Prisma.TransactionClient,
    jobOfferId: string,
    status: JobOfferStatus,
  ): Promise<void> {
    const offer = await tx.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: { status: true },
    });
    if (!offer || isTerminalJobOfferStatus(offer.status)) return;

    await tx.jobOffer.update({
      where: { id: jobOfferId },
      data: { status },
    });
  }

  /**
   * The reliability reward for reliably showing up and finishing.
   *
   * The quality signal (good or bad work) is applied separately when the worker
   * is rated (see applyRatingToReliability), since many completions never get
   * rated over WhatsApp. Skipped for a no-show.
   */
  private async rewardCompletion(
    tx: Prisma.TransactionClient,
    applicationId: string,
    workerId: string,
    fees: { completionScoreReward: number; reliabilityScoreMin: number },
  ): Promise<void> {
    if (fees.completionScoreReward === 0) return;

    const assignment = await tx.assignment.findUnique({
      where: { application_id: applicationId },
      select: { status: true },
    });
    if (assignment?.status === AssignmentStatus.NO_SHOW) return;

    const worker = await tx.profile.findUnique({
      where: { id: workerId },
      select: { reliability_score: true },
    });
    const currentScore = worker?.reliability_score ?? 100;
    const rewardedScore = Math.max(
      fees.reliabilityScoreMin,
      Math.min(
        RELIABILITY_SCORE_MAX,
        currentScore + fees.completionScoreReward,
      ),
    );
    if (rewardedScore !== currentScore) {
      await tx.profile.update({
        where: { id: workerId },
        data: { reliability_score: rewardedScore },
      });
    }
  }

  /**
   * Record a rating for one side of a completed assignment. Directional and
   * symmetric — the employer rates the worker OR the worker rates the employer;
   * the ratee is always the counter-party. Idempotent (unique on
   * rater+assignment → upsert). The reliability_score delta is a worker-only
   * quality signal, so it is applied only when an employer rates a worker, and
   * only on the first rating. Lifted from rate-assignment.flow so both the bot
   * and mobile share one implementation.
   */
  async rateAssignment(
    assignmentId: string,
    raterProfileId: string,
    score: number,
  ): Promise<void> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('La note doit être comprise entre 1 et 5.');
    }

    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        status: true,
        worker_id: true,
        job_offer_id: true,
        // category_id is denormalised onto the interaction event below.
        job_offer: { select: { employer_id: true, category_id: true } },
      },
    });
    if (!assignment) {
      throw new NotFoundException('Mission introuvable');
    }

    const isWorker = assignment.worker_id === raterProfileId;
    const isEmployer = assignment.job_offer?.employer_id === raterProfileId;
    if (!isWorker && !isEmployer) {
      throw new ForbiddenException(
        "Vous n'êtes pas autorisé à évaluer cette mission",
      );
    }
    if (assignment.status !== AssignmentStatus.COMPLETED) {
      throw new BadRequestException("La mission n'est pas encore terminée");
    }

    const rateeId = isWorker
      ? assignment.job_offer?.employer_id
      : assignment.worker_id;
    if (!rateeId) {
      throw new BadRequestException("Impossible de déterminer l'évalué");
    }

    await this.prisma.$transaction(async (tx) => {
      // First rating? Determines whether the reliability delta applies (only the
      // first time, never on a re-rate — otherwise it would be counted twice).
      const existing = await tx.rating.findUnique({
        where: {
          rater_id_assignment_id: {
            rater_id: raterProfileId,
            assignment_id: assignmentId,
          },
        },
        select: { id: true },
      });
      const isFirstRating = existing === null;

      await tx.rating.upsert({
        where: {
          rater_id_assignment_id: {
            rater_id: raterProfileId,
            assignment_id: assignmentId,
          },
        },
        create: {
          rater_id: raterProfileId,
          ratee_id: rateeId,
          assignment_id: assignmentId,
          score,
          // Stored so readers don't have to re-derive it by joining through
          // assignment → job_offer on every single read.
          direction: isEmployer
            ? RatingDirection.EMPLOYER_TO_WORKER
            : RatingDirection.WORKER_TO_EMPLOYER,
        },
        update: { score },
      });

      // Recompute the ratee's aggregate inside the same transaction.
      const agg = await tx.rating.aggregate({
        where: { ratee_id: rateeId },
        _avg: { score: true },
        _count: { score: true },
      });
      await tx.profile.update({
        where: { id: rateeId },
        data: {
          rating_avg: agg._avg.score ?? null,
          rating_count: agg._count.score,
        },
      });

      if (isEmployer && isFirstRating) {
        await this.applyRatingToReliability(tx, rateeId, score);
      }
    });

    // A rating is the only signal that reflects how the work actually went, so
    // it's the highest-confidence evidence either side gives us. 3/5 is neutral
    // and deliberately records nothing.
    if (score !== 3) {
      void this.interactionEvents.record({
        actorId: raterProfileId,
        actorType: isEmployer
          ? InteractionActor.EMPLOYER
          : InteractionActor.WORKER,
        kind:
          score > 3
            ? InteractionKind.RATE_POSITIVE
            : InteractionKind.RATE_NEGATIVE,
        objectType: isEmployer
          ? InteractionObject.WORKER_PROFILE
          : InteractionObject.EMPLOYER_PROFILE,
        objectId: rateeId,
        categoryId: assignment.job_offer?.category_id ?? null,
        counterpartyId: assignment.job_offer_id,
        source: InteractionSource.SERVER,
        surface: 'rating',
        metadata: { score },
      });
    }
  }

  /**
   * The employer rates the worker. That is all they do here.
   *
   * Completion belongs to the worker — they are the one who knows the work is
   * finished — so this no longer closes the offer or ends anything. It waits
   * for the worker's confirmation instead, which is also what makes the rating
   * meaningful: an employer cannot rate a mission nobody has said happened.
   */
  async rateWorkerForMission(
    applicationId: string,
    employerId: string,
    score: number,
    note?: string,
  ): Promise<void> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('La note doit être comprise entre 1 et 5.');
    }

    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        worker_id: true,
        job_offer_id: true,
        job_offer: { select: { employer_id: true, employment_type: true } },
      },
    });
    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.job_offer.employer_id !== employerId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }

    const assignment = await this.prisma.assignment.findFirst({
      where: { application_id: applicationId },
      select: { id: true, status: true },
    });
    if (!assignment) {
      throw new BadRequestException(
        'Aucune mission associée à cette candidature',
      );
    }
    if (assignment.status !== AssignmentStatus.COMPLETED) {
      // Who is being waited on depends on the type. On an ongoing engagement
      // the worker never confirms anything — the employer does, by confirming
      // the hire — so naming the worker here would send them chasing someone
      // who has nothing to do.
      throw new BadRequestException(
        closesOnFill(application.job_offer.employment_type)
          ? "Vous n'avez pas encore confirmé l'embauche pour cette offre."
          : "Le travailleur n'a pas encore confirmé la fin de la mission.",
      );
    }

    if (note !== undefined) {
      await this.prisma.assignment.update({
        where: { id: assignment.id },
        data: { note },
      });
    }
    await this.rateAssignment(assignment.id, employerId, score);

    // The worker's screen shows whether they have been rated, and the
    // employer's rating button disappears on it — neither happens on the other
    // party's device without this.
    this.jobEvents.emitJobChanged([employerId, application.worker_id], {
      jobOfferId: application.job_offer_id,
      applicationId,
      kind: 'rated',
    });
  }

  /**
   * The worker confirms their own mission is done.
   *
   * This is the only way a mission completes. The worker is the one who knows
   * the work is finished, so the employer no longer marks anything — they only
   * rate afterwards (see rateWorkerForMission).
   *
   * Settles this worker's own side, then closes the whole offer *only* if no
   * other hired worker is still outstanding: an offer can hire several people
   * (`quantity`), and the first to finish must not end the rest.
   */
  /**
   * The worker rates the employer without confirming anything.
   *
   * The mirror image of `rateWorkerForMission`. It exists because the worker's
   * only rating route until now was `completeAndRateByWorker`, which rates *and*
   * marks the mission finished — and marking an ongoing engagement finished is
   * refused outright. So on a CDD/CDI/STAGE the worker could not rate at all,
   * even once the employer had closed the offer and the employer could rate
   * them.
   *
   * `rateAssignment` already enforces the 1–5 range, the COMPLETED-assignment
   * gate and the direction, so this only resolves the assignment and checks
   * ownership.
   */
  async rateEmployerForMission(
    applicationId: string,
    workerId: string,
    score: number,
  ): Promise<void> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        worker_id: true,
        job_offer_id: true,
        job_offer: { select: { employer_id: true } },
      },
    });
    if (!application) {
      throw new NotFoundException('Candidature non trouvée');
    }
    if (application.worker_id !== workerId) {
      throw new ForbiddenException("Cette mission n'est pas la vôtre");
    }

    const assignment = await this.prisma.assignment.findFirst({
      where: { application_id: applicationId },
      select: { id: true },
    });
    if (!assignment) {
      throw new BadRequestException(
        'Aucune mission associée à cette candidature',
      );
    }

    await this.rateAssignment(assignment.id, workerId, score);

    this.jobEvents.emitJobChanged(
      [workerId, application.job_offer.employer_id],
      {
        jobOfferId: application.job_offer_id,
        applicationId,
        kind: 'rated',
      },
    );
  }

  /**
   * The employer confirms the people they hired actually took the job, which
   * closes a CDD/CDI/STAGE offer for good and opens the mutual rating.
   *
   * The counterpart of `markCompletedByWorker`, and the reason it cannot simply
   * be reused: on an ongoing engagement there is no moment the worker could
   * confirm. The work continues off-platform indefinitely, so waiting for
   * "it finished" means waiting forever — which is precisely how these offers
   * used to strand in FILLED with nobody able to rate anyone.
   *
   * Only reachable once recruiting has stopped (FILLED), so an employer cannot
   * close an offer that is still taking candidates.
   */
  async confirmHireByEmployer(
    jobOfferId: string,
    employerId: string,
  ): Promise<void> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        title: true,
        employer_id: true,
        status: true,
        employment_type: true,
      },
    });
    if (!offer) {
      throw new NotFoundException('Offre introuvable');
    }
    if (offer.employer_id !== employerId) {
      throw new ForbiddenException("Cette offre n'est pas la vôtre");
    }
    if (!closesOnFill(offer.employment_type)) {
      throw new BadRequestException(
        "Une mission ponctuelle se termine quand le travailleur confirme l'avoir faite, pas à l'embauche.",
      );
    }
    if (offer.status === JobOfferStatus.COMPLETED) {
      return; // Idempotent: the sweep may have got there first.
    }
    if (offer.status !== JobOfferStatus.FILLED) {
      throw new BadRequestException(
        'Cette offre recrute encore. Elle pourra être clôturée une fois tous les postes pourvus.',
      );
    }

    const rejectedOrphanIds = await this.prisma.$transaction((tx) =>
      closeRecruitedOfferTx(tx, jobOfferId),
    );

    this.notifyRejectedApplicants(rejectedOrphanIds);

    const hired = await this.prisma.application.findMany({
      where: { job_offer_id: jobOfferId, status: ApplicationStatus.END },
      select: { id: true, worker_id: true },
    });

    // Both sides' rating actions only appear once this lands, and neither
    // screen has another way to learn about it. One event per hired
    // application rather than one for the offer: a JobEvent names the
    // application it concerns, and each of these really did move to END.
    for (const application of hired) {
      this.jobEvents.emitJobChanged([employerId, application.worker_id], {
        jobOfferId,
        applicationId: application.id,
        kind: 'completed',
      });
    }

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_COMPLETED, {
      event: AdminNotificationEvent.APPLICATION_COMPLETED,
      title: 'Recrutement clôturé',
      message: `L'employeur a confirmé l'embauche pour l'offre "${offer.title}"`,
      entityType: 'job_offer',
      entityId: String(jobOfferId),
      timestamp: new Date().toISOString(),
    });
  }

  async markCompletedByWorker(
    applicationId: string,
    workerId: string,
  ): Promise<void> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: { job_offer: true, worker: true },
    });
    if (!application) {
      throw new NotFoundException('Candidature introuvable');
    }
    if (application.worker_id !== workerId) {
      throw new ForbiddenException("Cette mission n'est pas la vôtre");
    }
    // Only a one-off gig is ever "finished". A CDI, a CDD or a stage is an
    // ongoing engagement — there is no moment to confirm, so offering the
    // action at all would be misleading. Says which type rather than a generic
    // 400, because the caller cannot otherwise tell this from a state error.
    if (application.job_offer.employment_type !== EmploymentType.MISSION) {
      throw new BadRequestException(
        'Un contrat de type ' +
          `${application.job_offer.employment_type} ne se termine pas comme une mission ponctuelle.`,
      );
    }
    if (
      application.status !== ApplicationStatus.ACCEPTED &&
      application.status !== ApplicationStatus.STARTED &&
      application.status !== ApplicationStatus.END
    ) {
      throw new BadRequestException(
        'Cette mission ne peut pas être marquée comme terminée',
      );
    }

    const fees = await this.systemConfigService.getFees();
    let rejectedOrphanIds: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      // Ensure an assignment exists so the worker→employer rating can attach to
      // it. Some accepted applications may not have one yet (e.g. seeded data);
      // create it on the fly. If it already exists, just mark it completed.
      const existing = await tx.assignment.findFirst({
        where: { application_id: applicationId },
        select: { id: true, status: true },
      });
      if (!existing) {
        await tx.assignment.create({
          data: {
            application_id: applicationId,
            job_offer_id: application.job_offer_id,
            worker_id: workerId,
            status: AssignmentStatus.COMPLETED,
            completed_at: new Date(),
          },
        });
      } else if (existing.status !== AssignmentStatus.COMPLETED) {
        await tx.assignment.update({
          where: { id: existing.id },
          data: {
            status: AssignmentStatus.COMPLETED,
            completed_at: new Date(),
          },
        });
      }

      if (application.status !== ApplicationStatus.END) {
        await tx.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.END },
        });
      }

      await this.rewardCompletion(tx, applicationId, workerId, fees);

      rejectedOrphanIds = await this.closeOfferIfAllWorkersDone(
        tx,
        application.job_offer_id,
      );
    });

    this.notifyRejectedApplicants(rejectedOrphanIds);

    // Tell both sides the mission moved. The employer's rating action only
    // becomes available once this happens, and their screen has no other way to
    // learn about it — `invalidateQueries` runs in the worker's browser, not
    // theirs.
    this.jobEvents.emitJobChanged(
      [workerId, application.job_offer.employer_id],
      {
        jobOfferId: application.job_offer_id,
        applicationId,
        kind: 'completed',
      },
    );

    this.eventEmitter.emit(AdminNotificationEvent.APPLICATION_COMPLETED, {
      event: AdminNotificationEvent.APPLICATION_COMPLETED,
      title: 'Travail terminé',
      message: `${application.worker.first_name} ${application.worker.last_name} a confirmé la fin de sa mission pour l'offre "${application.job_offer.title}"`,
      entityType: 'application',
      entityId: String(applicationId),
      timestamp: new Date().toISOString(),
    });

    // Re-index worker to enrich their embedding with completed job history
    this.matchingService
      .indexWorkerProfile(workerId)
      .catch((err) =>
        console.warn(`Failed to re-index worker after job completion:`, err),
      );

    // A completed job is the highest-confidence evidence the pairing worked, so
    // it is recorded from BOTH sides: the employer learns about this worker, and
    // the worker learns about this kind of offer/employer.
    void this.interactionEvents.record({
      actorId: application.job_offer.employer_id,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.COMPLETE,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: workerId,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer_id,
      source: InteractionSource.SERVER,
      surface: 'job_complete',
    });
    void this.interactionEvents.record({
      actorId: workerId,
      actorType: InteractionActor.WORKER,
      kind: InteractionKind.COMPLETE,
      objectType: InteractionObject.JOB_OFFER,
      objectId: application.job_offer_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer.employer_id,
      source: InteractionSource.SERVER,
      surface: 'job_complete',
    });
  }

  /**
   * Worker marks their side done and rates the employer in one action. Mirrors
   * completeAndRate but for the worker direction (no offer close / payment; the
   * reliability delta is skipped inside rateAssignment for worker→employer).
   */
  async completeAndRateByWorker(
    applicationId: string,
    workerId: string,
    score: number,
  ): Promise<void> {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('La note doit être comprise entre 1 et 5.');
    }
    await this.markCompletedByWorker(applicationId, workerId);
    const assignment = await this.prisma.assignment.findFirst({
      where: { application_id: applicationId },
      select: { id: true },
    });
    if (!assignment) {
      throw new BadRequestException(
        'Aucune mission associée à cette candidature',
      );
    }
    await this.rateAssignment(assignment.id, workerId, score);
  }

  /**
   * The worker's own "missions" — applications they were hired on (ACCEPTED /
   * STARTED / END), with the offer + employer and whether the worker has already
   * rated the employer for that assignment. Powers the worker mission surface.
   */
  async findWorkerMissions(
    workerId: string,
    pagination: { page: number; pageSize: number },
  ): Promise<{ items: WorkerMissionCard[]; total: number }> {
    const where: Prisma.ApplicationWhereInput = {
      worker_id: workerId,
      deleted_at: null,
      status: {
        in: [
          ApplicationStatus.ACCEPTED,
          ApplicationStatus.STARTED,
          ApplicationStatus.END,
        ],
      },
    };
    const { page, pageSize } = pagination;
    const [applications, total] = await Promise.all([
      this.prisma.application.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: page * pageSize,
        take: pageSize,
        select: WORKER_MISSION_SELECT,
      }),
      this.prisma.application.count({ where }),
    ]);
    const items = await this.toWorkerMissionCards(workerId, applications);
    return { items, total };
  }

  async findWorkerMissionById(
    workerId: string,
    applicationId: string,
  ): Promise<WorkerMissionCard> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, worker_id: workerId, deleted_at: null },
      select: WORKER_MISSION_SELECT,
    });
    if (!application) {
      throw new NotFoundException('Mission introuvable');
    }

    // Backfill a missing contract for an engaged application. accept() creates
    // contract metadata fire-and-forget (so a failure there is never retried),
    // and applications that never went through accept() — seeded data — have no
    // contract row at all. Same self-heal-on-read approach used for a missing
    // assignment in markCompletedByWorker. create() is idempotent.
    let contract = application.contract;
    if (
      !contract &&
      (application.status === ApplicationStatus.ACCEPTED ||
        application.status === ApplicationStatus.STARTED ||
        application.status === ApplicationStatus.END)
    ) {
      try {
        const created = await this.contractService.create(applicationId);
        contract = { id: created.id };
      } catch (err) {
        console.warn(
          `Failed to backfill contract for application ${applicationId}:`,
          err,
        );
      }
    }

    const [card] = await this.toWorkerMissionCards(workerId, [
      { ...application, contract },
    ]);
    return card;
  }

  private async toWorkerMissionCards(
    workerId: string,
    applications: WorkerMissionRow[],
  ): Promise<WorkerMissionCard[]> {
    // Batch the "did I already rate the employer?" lookup to avoid N+1.
    const assignmentIds = applications
      .map((a) => a.assignment?.id)
      .filter((id): id is string => Boolean(id));
    const ratedAssignmentIds = new Set(
      assignmentIds.length === 0
        ? []
        : (
            await this.prisma.rating.findMany({
              where: {
                rater_id: workerId,
                assignment_id: { in: assignmentIds },
              },
              select: { assignment_id: true },
            })
          ).map((r) => r.assignment_id),
    );

    return applications.map((a) => ({
      applicationId: a.id,
      applicationStatus: a.status,
      assignmentStatus: a.assignment?.status ?? null,
      ratedEmployer: a.assignment
        ? ratedAssignmentIds.has(a.assignment.id)
        : false,
      contractId: a.contract?.id ?? null,
      jobOffer: {
        id: a.job_offer.id,
        title: a.job_offer.title,
        description: a.job_offer.description,
        scheduledAt: a.job_offer.scheduled_at?.toISOString() ?? null,
        employmentType: a.job_offer.employment_type,
        amount: a.job_offer.amount == null ? null : Number(a.job_offer.amount),
        address: a.job_offer.address,
        isRemote: a.job_offer.is_remote,
        city: a.job_offer.city,
        countryName: a.job_offer.country_name,
        note: a.job_offer.note,
        status: a.job_offer.status,
      },
      employer: {
        id: a.job_offer.employer.id,
        firstName: a.job_offer.employer.first_name,
        lastName: a.job_offer.employer.last_name,
        reliabilityScore: a.job_offer.employer.reliability_score,
        avatarUrl: a.job_offer.employer.avatar_url,
        ratingAvg: a.job_offer.employer.rating_avg,
        ratingCount: a.job_offer.employer.rating_count,
      },
    }));
  }

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
    // Same reversible-hire rule as the worker's own cancel: on an ongoing
    // engagement END means "we closed the offer once this person was hired",
    // and an employer whose hire never showed up must be able to take the
    // position back rather than lose the whole posting.
    const isReversibleHire =
      application.status === ApplicationStatus.END &&
      closesOnFill(application.job_offer.employment_type);

    if (
      application.status !== ApplicationStatus.ACCEPTED &&
      application.status !== ('WAITING_PAYMENT' as ApplicationStatus) &&
      !isReversibleHire
    ) {
      throw new BadRequestException(
        'Seule une candidature acceptée ou en attente de paiement peut être annulée ici',
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Lock and re-check status inside the transaction so a concurrent/
      // duplicate cancel cannot deduct the employer reliability score twice.
      await tx.$executeRaw`SELECT id FROM "applications" WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const fresh = await tx.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      if (fresh?.status === ApplicationStatus.CANCELLED) {
        throw new BadRequestException('Cette candidature est déjà annulée');
      }

      await tx.application.update({
        where: { id: applicationId },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason: "Annulée par l'employeur",
        },
      });
      // See the worker-side cancel: on an undone hire the other hires sit at
      // END, so they have to be counted or a staffed offer reads as empty.
      const remainingAccepted = await tx.application.count({
        where: {
          job_offer_id: application.job_offer_id,
          status: {
            in: isReversibleHire
              ? [
                  ApplicationStatus.ACCEPTED,
                  'WAITING_PAYMENT' as ApplicationStatus,
                  ApplicationStatus.END,
                ]
              : [
                  ApplicationStatus.ACCEPTED,
                  'WAITING_PAYMENT' as ApplicationStatus,
                ],
          },
          id: { not: applicationId },
        },
      });
      const reopenStatus =
        remainingAccepted > 0
          ? JobOfferStatus.PARTIALLY_FILLED
          : JobOfferStatus.ACTIVE;
      if (isReversibleHire) {
        // Bypasses the terminal guard on purpose — undoing the hire is the one
        // legitimate route back out of COMPLETED.
        await tx.jobOffer.update({
          where: { id: application.job_offer_id },
          data: { status: reopenStatus },
        });
      } else {
        await this.reopenOfferUnlessClosed(
          tx,
          application.job_offer_id,
          reopenStatus,
        );
      }
      await tx.assignment.updateMany({
        where: { application_id: applicationId },
        data: {
          status: AssignmentStatus.CANCELLED_BY_EMPLOYER,
          cancelled_at: now,
        },
      });
      // Deduct employer reliability score only for late cancellations (within threshold window)
      const fees = await this.systemConfigService.getFees();
      // Same rule as the worker side: no closing date, no deadline, no penalty.
      const scheduledAt = application.job_offer.scheduled_at;
      const isLateCancel =
        scheduledAt !== null &&
        (scheduledAt.getTime() - now.getTime()) / (60 * 60 * 1000) <
          fees.cancellationThresholdHours;
      if (isLateCancel) {
        const employer = await tx.profile.findUnique({
          where: { id: employerId },
          select: { reliability_score: true },
        });
        const currentScore = employer?.reliability_score ?? 100;
        const newScore = Math.max(
          fees.reliabilityScoreMin,
          currentScore - fees.employerLateCancelScoreDeduction,
        );
        await tx.profile.update({
          where: { id: employerId },
          data: { reliability_score: newScore },
        });
      }
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

    // The EMPLOYER dropped an already-accepted worker — attributed to the
    // employer, unlike `cancel()` where the worker walks away. Getting the actor
    // wrong here would teach the wrong person's model.
    void this.interactionEvents.record({
      actorId: employerId,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.APPLY_CANCEL,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: application.worker_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer_id,
      source: InteractionSource.SERVER,
      surface: 'employer_cancel',
    });

    return updated;
  }

  async markAsViewed(applicationId: string): Promise<void> {
    const updated = await this.prisma.application.updateMany({
      where: {
        id: applicationId,
        status: ApplicationStatus.PENDING,
      },
      data: {
        status: ApplicationStatus.VIEWED,
        viewed_at: new Date(),
      },
    });
    if (updated.count === 0) return;

    // An employer opening a candidature is a genuine (if weak) interest signal in
    // that worker. Only recorded on the PENDING → VIEWED transition, so
    // re-opening the same application doesn't inflate it.
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        worker_id: true,
        job_offer_id: true,
        job_offer: { select: { employer_id: true, category_id: true } },
      },
    });
    if (!application?.job_offer) return;

    void this.interactionEvents.record({
      actorId: application.job_offer.employer_id,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.PROFILE_VIEW,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: application.worker_id,
      categoryId: application.job_offer.category_id,
      counterpartyId: application.job_offer_id,
      source: InteractionSource.SERVER,
      surface: 'application_detail',
    });
  }

  /** Update worker billing_status based on current unpaid penalty count. Call within a tx or after writes. */
  private async syncBillingStatus(
    workerId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const unpaidCount = await db.penalty.count({
      where: { profile_id: workerId, paid_at: null },
    });
    const fees = await this.systemConfigService.getFees();
    let newStatus: BillingStatus;
    if (unpaidCount === 0) {
      newStatus = BillingStatus.CLEAR;
    } else if (unpaidCount >= fees.billingBlockThreshold) {
      newStatus = BillingStatus.BLOCKED;
    } else {
      newStatus = BillingStatus.PENDING_PAYMENT;
    }
    await db.profile.update({
      where: { id: workerId },
      data: { billing_status: newStatus },
    });
  }

  /**
   * The worker's daily application quota (resets each day at local midnight).
   * Powers the "X/10 candidatures aujourd'hui" counter on the worker home.
   */
  /**
   * Applications that currently occupy one of the worker's concurrent slots:
   * still-open applications (PENDING / ACCEPTED) on offers that haven't closed.
   * Shared by create()'s concurrency check and the quota surface so the number
   * shown to the worker can never drift from the one that blocks them.
   */
  /**
   * Applications created since the current business day began (UTC+1 midnight).
   *
   * Cancelled applications intentionally still count: the cap exists to stop
   * spam-applying, and refunding quota on cancel would let a worker loop
   * apply → cancel → apply indefinitely. Soft-deleted rows do NOT count — those
   * are administrative removals, not something the worker did.
   */
  private countApplicationsToday(workerId: string): Promise<number> {
    return this.prisma.application.count({
      where: {
        worker_id: workerId,
        deleted_at: null,
        created_at: { gte: startOfBusinessDay() },
      },
    });
  }

  /**
   * The only limit that gates applying: the per-day cap.
   *
   * `concurrent` used to be reported here too and was the binding one. It is
   * gone — `resetsAt` is now the whole truth about when the worker can apply
   * again, which it was not while a concurrent cap that midnight never cleared
   * sat behind the same widget.
   */
  async getDailyApplicationQuota(workerId: string): Promise<{
    used: number;
    limit: number;
    remaining: number;
    resetsAt: string;
  }> {
    const fees = await this.systemConfigService.getFees();
    const limit = fees.maxDailyApplications;
    const used = await this.countApplicationsToday(workerId);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetsAt: startOfNextBusinessDay().toISOString(),
    };
  }

  async getUnpaidPenalties(
    workerId: string,
  ): Promise<{ count: number; total: number; ids: string[] }> {
    const penalties = await this.prisma.penalty.findMany({
      where: { profile_id: workerId, paid_at: null },
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
        where: { profile_id: workerId, paid_at: null },
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
            is_remote: true,
            city: true,
            country_name: true,
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
      jobScheduledAt: app.job_offer.scheduled_at?.toISOString() ?? null,
      jobAmount: Number(app.job_offer.amount),
      jobAddress: jobLocationLabel(app.job_offer),
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
        app.penalty_amount == null ? null : Number(app.penalty_amount),
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
    workerId?: string;
    employerId?: string;
    deleted?: boolean;
  }): Promise<{
    data: AdminApplicationListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.cache.wrap(
      this.cache.listKey('applications', params),
      ADMIN_LIST_TTL_SECONDS,
      () => this.loadGetApplicationsForAdmin(params),
    );
  }

  private async loadGetApplicationsForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: ApplicationStatus[];
    penaltyApplied?: string[];
    workerId?: string;
    employerId?: string;
    deleted?: boolean;
  }): Promise<{
    data: AdminApplicationListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const {
      page,
      limit,
      q,
      status,
      penaltyApplied,
      workerId,
      employerId,
      deleted,
    } = params;
    const skip = (page - 1) * limit;

    // Active rows by default; the admin "Deleted" filter flips to archived rows.
    const where: Prisma.ApplicationWhereInput = {
      deleted_at: deletedAtFilter(deleted),
    };

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      const parts = searchTrimmed.split(/\s+/).filter(Boolean);
      const orClauses: Prisma.ApplicationWhereInput[] = [
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
      if (parts.length >= 2) {
        orClauses.push(
          {
            AND: [
              {
                worker: {
                  first_name: { contains: parts[0], mode: 'insensitive' },
                },
              },
              {
                worker: {
                  last_name: {
                    contains: parts.slice(1).join(' '),
                    mode: 'insensitive',
                  },
                },
              },
            ],
          },
          {
            AND: [
              {
                worker: {
                  first_name: {
                    contains: parts.slice(1).join(' '),
                    mode: 'insensitive',
                  },
                },
              },
              {
                worker: {
                  last_name: { contains: parts[0], mode: 'insensitive' },
                },
              },
            ],
          },
        );
      }
      where.OR = orClauses;
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
    if (workerId) {
      where.worker_id = workerId;
    }
    if (employerId) {
      where.job_offer = { employer_id: employerId };
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

  /** Archive many applications at once (admin bulk delete). Returns the count archived. */
  async bulkSoftDeleteApplications(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const { count } = await this.prisma.application.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    await this.cache.invalidate('applications');
    return { count };
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
      scheduled_at: Date | null;
      amount: unknown;
      address: string | null;
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
      scheduled_at: Date | null;
      amount: unknown;
      payment_flow: string | null;
      address: string | null;
      is_remote: boolean;
      city: string | null;
      country_name: string | null;
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
    contract?: { id: string } | null;
  }): ApplicationWithOffer {
    return {
      ...this.toListItem({ ...app, job_offer: app.job_offer }),
      job_offer: {
        id: app.job_offer.id,
        title: app.job_offer.title,
        description: app.job_offer.description,
        scheduled_at: app.job_offer.scheduled_at,
        amount:
          app.job_offer.amount == null ? null : Number(app.job_offer.amount),
        payment_flow: app.job_offer.payment_flow,
        address: app.job_offer.address,
        is_remote: app.job_offer.is_remote,
        city: app.job_offer.city,
        country_name: app.job_offer.country_name,
        note: app.job_offer.note,
        status: app.job_offer.status,
        employer_id: app.job_offer.employer_id,
        employer: app.job_offer.employer,
      },
      worker: app.worker,
      contractId: app.contract?.id ?? null,
    } as ApplicationWithOffer;
  }
}
