import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { isWorkerHardBlocked } from '../penalty/penalty.utils';
import { MailService } from '../mail/mail.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { MatchingService } from '../matching/matching.service';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { AdminUpdateJobOfferDto } from './dto/admin-update-job-offer.dto';
import {
  AccountStatus,
  ApplicationStatus,
  JobOfferStatus,
  Prisma,
} from '@prisma/client';

const MIN_SCHEDULED_HOURS_FROM_NOW = 4;
const TITLE_MIN = 5;
const TITLE_MAX = 100;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1000;
const AMOUNT_MIN_FCFA = 1000;
const AMOUNT_MAX_FCFA = 1_000_000;
const ADDRESS_MIN = 10;
const NOTE_MAX = 500;
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 100;

export type AdminJobOfferListItem = {
  id: string;
  title: string;
  category: { id: string; name: string } | null;
  description: string;
  scheduledAt: string;
  amount: number | null;
  paymentFlow: string | null;
  address: string;
  note: string | null;
  quantity: number;
  status: string;
  employerName: string;
  employerEmail: string;
  employerPhone: string;
  employerAvatarUrl: string | null;
  employerId: string;
  applicationsCount: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminJobOfferApplicationItem = {
  id: string;
  workerName: string;
  workerEmail: string;
  workerPhone: string;
  workerAvatarUrl: string | null;
  workerId: string;
  status: string;
  penaltyApplied: boolean;
  penaltyAmount: number | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
};

export type AdminJobOfferDetailResponse = AdminJobOfferListItem & {
  applications: AdminJobOfferApplicationItem[];
};

export type JobOfferListItem = {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount: number;
  status: string;
  employer_id: string;
  created_at: Date;
};

export type JobOfferDetail = JobOfferListItem & {
  employer?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    reliability_score: number | null;
  };
};

@Injectable()
export class JobOfferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly systemConfigService: SystemConfigService,
    private readonly walletService: WalletService,
    private readonly botNotification: BotNotificationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly matchingService: MatchingService,
  ) {}

  async create(
    employerId: string,
    dto: CreateJobOfferDto,
  ): Promise<JobOfferListItem> {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: {
        id: true,
        status: true,
        profile_type: true,
        reliability_score: true,
      },
    });
    if (!employer) {
      throw new NotFoundException('Employeur introuvable');
    }
    if (employer.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException(
        'Le profil doit être actif pour publier des offres',
      );
    }
    if (employer.profile_type !== 'EMPLOYER') {
      throw new ForbiddenException(
        "Seuls les employeurs peuvent publier des offres d'emploi",
      );
    }

    const fees = await this.systemConfigService.getFees();
    const employerScore = employer.reliability_score ?? 100;
    if (employerScore <= fees.reliabilityScoreMin) {
      throw new ForbiddenException(
        "Votre compte est pénalisé. Vous ne pouvez pas publier d'offres pour le moment.",
      );
    }

    const hardBlocked = await isWorkerHardBlocked(this.prisma, employerId);
    if (hardBlocked) {
      throw new ForbiddenException(
        "🚨 Votre compte est bloqué en raison de pénalités impayées depuis plus de 3 jours. Tapez PAYER pour régulariser votre situation.",
      );
    }

    this.validateCreateDto(dto);

    const scheduledAt = new Date(dto.scheduled_at);
    const now = new Date();
    const minDate = new Date(
      now.getTime() + MIN_SCHEDULED_HOURS_FROM_NOW * 60 * 60 * 1000,
    );
    if (scheduledAt < minDate) {
      throw new BadRequestException(
        'La date doit être au moins 4 heures dans le futur',
      );
    }

    const offer = await this.prisma.jobOffer.create({
      data: {
        employer_id: employerId,
        title: dto.title.trim(),
        description: dto.description.trim(),
        scheduled_at: scheduledAt,
        amount: dto.amount,
        payment_flow: dto.payment_flow,
        address: dto.address.trim(),
        note: dto.note?.trim() ?? null,
        quantity: dto.quantity ?? 1,
        status: JobOfferStatus.ACTIVE,
        ...(dto.category_id ? { category_id: dto.category_id } : {}),
      },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_CREATED, {
      event: AdminNotificationEvent.JOB_OFFER_CREATED,
      title: 'Nouvelle offre',
      message: `Nouvelle offre d'emploi créée : ${offer.title}`,
      entityType: 'job-offer',
      entityId: String(offer.id),
      timestamp: new Date().toISOString(),
    });

    // Index + notify matching workers asynchronously (fire-and-forget)
    this.matchingService
      .indexJobOffer(offer.id)
      .then(async () => {
        const workerResults: { id: string; score: number }[] =
          await this.matchingService.findMatchingWorkersForJob(offer.id, 20);
        for (const { id: workerId } of workerResults) {
          this.botNotification
            .sendRecommendedJobNotification(workerId, offer.id)
            .catch(() => {});
        }
      })
      .catch(() => {});

    return this.toListItem(offer);
  }

  /**
   * Worker-facing offers must still have at least one free slot.
   * Status can lag (e.g. ACTIVE while acceptedCount === quantity); we filter on counts.
   */
  private offerHasOpenSlots(quantity: number, acceptedCount: number): boolean {
    const accepted = Number.isFinite(acceptedCount) ? acceptedCount : 0;
    return accepted < quantity;
  }

  private async queryOpenSlotCandidateBatch(
    take: number,
    dbCursor: string | undefined,
    excludeAppliedByWorkerId?: string,
  ): Promise<
    Prisma.JobOfferGetPayload<{
      include: {
        _count: {
          select: {
            applications: {
              where: { status: typeof ApplicationStatus.ACCEPTED };
            };
          };
        };
      };
    }>[]
  > {
    return this.prisma.jobOffer.findMany({
      take,
      ...(dbCursor ? { cursor: { id: dbCursor }, skip: 1 } : {}),
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        ...(excludeAppliedByWorkerId
          ? {
              applications: {
                none: { worker_id: excludeAppliedByWorkerId },
              },
            }
          : {}),
      },
      orderBy: [{ scheduled_at: 'asc' }, { created_at: 'desc' }],
      include: {
        _count: {
          select: {
            applications: { where: { status: ApplicationStatus.ACCEPTED } },
          },
        },
      },
    });
  }

  private mergeOpenSlotOffersIntoList(
    offers: Prisma.JobOfferGetPayload<{
      include: {
        _count: {
          select: {
            applications: {
              where: { status: typeof ApplicationStatus.ACCEPTED };
            };
          };
        };
      };
    }>[],
    listItems: JobOfferListItem[],
    targetCount: number,
  ): void {
    for (const o of offers) {
      const accepted = o._count.applications;
      if (!this.offerHasOpenSlots(o.quantity, accepted)) continue;
      listItems.push(this.toListItem(o, accepted));
      if (listItems.length >= targetCount) break;
    }
  }

  async findActive(
    limit = 20,
    cursor?: string,
    excludeAppliedByWorkerId?: string,
  ): Promise<{
    data: JobOfferListItem[];
    nextCursor: string | null;
  }> {
    const targetCount = limit + 1;
    const listItems: JobOfferListItem[] = [];
    let dbCursor: string | undefined = cursor;
    const batchSize = Math.max(limit * 8, limit + 15);
    const maxIterations = 25;

    for (let i = 0; i < maxIterations && listItems.length < targetCount; i++) {
      const offers = await this.queryOpenSlotCandidateBatch(
        batchSize,
        dbCursor,
        excludeAppliedByWorkerId,
      );
      if (offers.length === 0) break;

      this.mergeOpenSlotOffersIntoList(offers, listItems, targetCount);

      dbCursor = offers.at(-1)!.id;
      if (offers.length < batchSize) break;
    }

    const hasMore = listItems.length > limit;
    const data = hasMore ? listItems.slice(0, limit) : listItems;
    const nextCursor = hasMore ? (data.at(-1)?.id ?? null) : null;

    return { data, nextCursor };
  }

  async findRecommendedForWorker(
    workerId: string,
    limit = 10,
  ): Promise<JobOfferListItem[]> {
    const recommendedResults: { id: string; score: number }[] =
      await this.matchingService.findMatchingJobsForWorker(workerId, limit);
    const recommendedIds: string[] = recommendedResults.map((r) => r.id);

    if (recommendedIds.length > 0) {
      const offers = await this.prisma.jobOffer.findMany({
        where: {
          id: { in: recommendedIds },
          status: {
            in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
          },
          applications: { none: { worker_id: workerId } },
        },
        include: {
          _count: {
            select: { applications: { where: { status: 'ACCEPTED' } } },
          },
        },
      });
      const offerMap = new Map(offers.map((o) => [o.id, o]));
      return recommendedIds.flatMap((id) => {
        const o = offerMap.get(id);
        if (!o) return [];
        const accepted = o._count.applications;
        if (!this.offerHasOpenSlots(o.quantity, accepted)) return [];
        return [this.toListItem(o, accepted)];
      });
    }

    const { data } = await this.findActive(limit, undefined, workerId);
    return data;
  }

  async findById(id: string): Promise<JobOfferDetail | null> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      include: {
        employer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            reliability_score: true,
          },
        },
        _count: {
          select: {
            applications: { where: { status: 'ACCEPTED' } },
          },
        },
      },
    });
    if (!offer) return null;

    return {
      ...this.toListItem(offer, offer._count.applications),
      employer: offer.employer
        ? {
            id: offer.employer.id,
            first_name: offer.employer.first_name,
            last_name: offer.employer.last_name,
            phone: offer.employer.phone,
            reliability_score: offer.employer.reliability_score,
          }
        : undefined,
    };
  }

  async findByEmployerId(employerId: string): Promise<JobOfferListItem[]> {
    const offers = await this.prisma.jobOffer.findMany({
      where: { employer_id: employerId },
      orderBy: [{ scheduled_at: 'asc' }, { created_at: 'desc' }],
    });
    return offers.map((o) => this.toListItem(o));
  }

  async updateStatus(
    id: string,
    status: JobOfferStatus,
    actorProfileId: string,
  ): Promise<JobOfferListItem> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.employer_id !== actorProfileId) {
      throw new ForbiddenException('Non autorisé à modifier cette offre');
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED, {
      event: AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED,
      title: 'Statut offre modifié',
      message: `Le statut de l'offre "${updated.title}" a été changé en ${status}`,
      entityType: 'job-offer',
      entityId: String(updated.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(updated);
  }

  async updateStatusByAdmin(
    id: string,
    status: JobOfferStatus,
  ): Promise<JobOfferListItem> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED, {
      event: AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED,
      title: 'Statut offre modifié',
      message: `Le statut de l'offre "${updated.title}" a été changé en ${status}`,
      entityType: 'job-offer',
      entityId: String(updated.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(updated);
  }

  validateCreateDto(dto: CreateJobOfferDto): void {
    if (
      !dto.title ||
      dto.title.trim().length < TITLE_MIN ||
      dto.title.trim().length > TITLE_MAX
    ) {
      throw new BadRequestException(
        `Le titre doit contenir entre ${TITLE_MIN} et ${TITLE_MAX} caractères`,
      );
    }
    if (
      !dto.description ||
      dto.description.trim().length < DESCRIPTION_MIN ||
      dto.description.trim().length > DESCRIPTION_MAX
    ) {
      throw new BadRequestException(
        `La description doit contenir entre ${DESCRIPTION_MIN} et ${DESCRIPTION_MAX} caractères`,
      );
    }
    const scheduledAt = new Date(dto.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Format de date invalide');
    }
    if (
      dto.amount != null &&
      (dto.amount < AMOUNT_MIN_FCFA || dto.amount > AMOUNT_MAX_FCFA)
    ) {
      throw new BadRequestException(
        `Le montant doit être entre ${AMOUNT_MIN_FCFA} et ${AMOUNT_MAX_FCFA} FCFA`,
      );
    }
    if (!dto.address || dto.address.trim().length < ADDRESS_MIN) {
      throw new BadRequestException(
        `L'adresse doit contenir au moins ${ADDRESS_MIN} caractères`,
      );
    }
    if (dto.note != null && dto.note.length > NOTE_MAX) {
      throw new BadRequestException(
        `La note ne peut pas dépasser ${NOTE_MAX} caractères`,
      );
    }
    if (
      dto.quantity != null &&
      (!Number.isInteger(dto.quantity) ||
        dto.quantity < QUANTITY_MIN ||
        dto.quantity > QUANTITY_MAX)
    ) {
      throw new BadRequestException(
        `Le nombre de personnes doit être entre ${QUANTITY_MIN} et ${QUANTITY_MAX}`,
      );
    }
  }

  async getJobOffersForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: JobOfferStatus[];
  }): Promise<{
    data: AdminJobOfferListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, status } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.JobOfferWhereInput = {};

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      where.OR = [
        { title: { contains: searchTrimmed, mode: 'insensitive' } },
        { description: { contains: searchTrimmed, mode: 'insensitive' } },
        { address: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
    }

    if (status != null && status.length > 0) {
      where.status = { in: status };
    }

    const [offers, total] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          category: {
            select: {
              id: true,
              name: true,
            },
          },
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
          _count: {
            select: { applications: true },
          },
        },
      }),
      this.prisma.jobOffer.count({ where }),
    ]);

    const data: AdminJobOfferListItem[] = offers.map((o) => ({
      id: o.id,
      title: o.title,
      category:
        o.category == null
          ? null
          : { id: o.category.id, name: o.category.name },
      description: o.description,
      scheduledAt: o.scheduled_at.toISOString(),
      amount: Number(o.amount),
      paymentFlow: o.payment_flow,
      address: o.address,
      note: o.note,
      quantity: o.quantity,
      status: o.status,
      employerName:
        `${o.employer.first_name ?? ''} ${o.employer.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: o.employer.email,
      employerPhone: o.employer.phone,
      employerAvatarUrl: o.employer.avatar_url ?? null,
      employerId: o.employer_id,
      applicationsCount: o._count.applications,
      createdAt: o.created_at.toISOString(),
      updatedAt: o.updated_at.toISOString(),
    }));

    return { data, total, page, limit };
  }

  async getJobOfferDetailForAdmin(
    id: string,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
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
        applications: {
          orderBy: { created_at: 'desc' },
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
          },
        },
        _count: {
          select: { applications: true },
        },
      },
    });

    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    return {
      id: offer.id,
      title: offer.title,
      category:
        offer.category == null
          ? null
          : { id: offer.category.id, name: offer.category.name },
      description: offer.description,
      scheduledAt: offer.scheduled_at.toISOString(),
      amount: Number(offer.amount),
      paymentFlow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      quantity: offer.quantity,
      status: offer.status,
      employerName:
        `${offer.employer.first_name ?? ''} ${offer.employer.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: offer.employer.email,
      employerPhone: offer.employer.phone,
      employerAvatarUrl: offer.employer.avatar_url ?? null,
      employerId: offer.employer_id,
      applicationsCount: offer._count.applications,
      createdAt: offer.created_at.toISOString(),
      updatedAt: offer.updated_at.toISOString(),
      applications: offer.applications.map((a) => ({
        id: a.id,
        workerName:
          `${a.worker.first_name ?? ''} ${a.worker.last_name ?? ''}`.trim() ||
          '—',
        workerEmail: a.worker.email,
        workerPhone: a.worker.phone,
        workerAvatarUrl: a.worker.avatar_url ?? null,
        workerId: a.worker_id,
        status: a.status,
        penaltyApplied: a.penalty_applied,
        penaltyAmount:
          a.penalty_amount == null ? null : Number(a.penalty_amount),
        cancelledAt: a.cancelled_at?.toISOString() ?? null,
        cancellationReason: a.cancellation_reason,
        createdAt: a.created_at.toISOString(),
      })),
    };
  }

  async deleteJobOfferByAdmin(id: string): Promise<void> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    await this.prisma.jobOffer.delete({ where: { id } });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_DELETED, {
      event: AdminNotificationEvent.JOB_OFFER_DELETED,
      title: 'Offre supprimée',
      message: `L'offre d'emploi "${offer.title}" a été supprimée`,
      entityType: 'job-offer',
      entityId: String(id),
      timestamp: new Date().toISOString(),
    });
  }

  async updateJobOfferByAdmin(
    id: string,
    dto: AdminUpdateJobOfferDto,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.status !== JobOfferStatus.ACTIVE) {
      throw new BadRequestException('Only active job offers can be edited');
    }

    const data: Prisma.JobOfferUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim();
    if (dto.scheduledAt !== undefined)
      data.scheduled_at = new Date(dto.scheduledAt);
    if (dto.amount !== undefined) data.amount = dto.amount ?? null;
    if (dto.paymentFlow !== undefined)
      data.payment_flow = dto.paymentFlow ?? null;
    if (dto.categoryId !== undefined) {
      if (dto.categoryId === null) {
        data.category = { disconnect: true };
      } else {
        data.category = { connect: { id: dto.categoryId } };
      }
    }
    if (dto.address !== undefined) data.address = dto.address.trim();
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;

    const updatedOffer = await this.prisma.jobOffer.update({
      where: { id },
      data,
      select: { title: true },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_UPDATED, {
      event: AdminNotificationEvent.JOB_OFFER_UPDATED,
      title: 'Offre mise à jour',
      message: `L'offre d'emploi "${updatedOffer.title}" a été mise à jour par un admin`,
      entityType: 'job-offer',
      entityId: String(id),
      timestamp: new Date().toISOString(),
    });

    return this.getJobOfferDetailForAdmin(id);
  }

  private toListItem(
    offer: {
      id: string;
      title: string;
      description: string;
      scheduled_at: Date;
      amount: unknown;
      payment_flow: string | null;
      address: string;
      note: string | null;
      quantity: number;
      status: string;
      employer_id: string;
      created_at: Date;
    },
    acceptedCount = 0,
  ): JobOfferListItem {
    return {
      id: offer.id,
      title: offer.title,
      description: offer.description,
      scheduled_at: offer.scheduled_at,
      amount: offer.amount == null ? null : Number(offer.amount),
      payment_flow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      quantity: offer.quantity,
      acceptedCount,
      status: offer.status,
      employer_id: offer.employer_id,
      created_at: offer.created_at,
    };
  }
}
