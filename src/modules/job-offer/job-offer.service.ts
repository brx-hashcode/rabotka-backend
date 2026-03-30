import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { AdminUpdateJobOfferDto } from './dto/admin-update-job-offer.dto';
import {
  AccountStatus,
  JobOfferStatus,
  PaymentFlow,
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
  description: string;
  scheduledAt: string;
  amount: number;
  paymentFlow: string;
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
  amount: number;
  payment_flow: string;
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
  ) {}

  async create(
    employerId: string,
    dto: CreateJobOfferDto,
  ): Promise<JobOfferListItem> {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { id: true, status: true, profile_type: true },
    });
    if (!employer) {
      throw new NotFoundException('Employeur introuvable');
    }
    if (employer.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Le profil doit être actif pour publier des offres');
    }
    if (employer.profile_type !== 'EMPLOYER') {
      throw new ForbiddenException("Seuls les employeurs peuvent publier des offres d'emploi");
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
        status: JobOfferStatus.PENDING_PAYMENT,
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

    return this.toListItem(offer);
  }

  async findActive(
    limit = 20,
    cursor?: string,
    excludeAppliedByWorkerId?: string,
  ): Promise<{
    data: JobOfferListItem[];
    nextCursor: string | null;
  }> {
    const offers = await this.prisma.jobOffer.findMany({
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      where: {
        status: JobOfferStatus.ACTIVE,
        ...(excludeAppliedByWorkerId
          ? {
              applications: {
                none: {
                  worker_id: excludeAppliedByWorkerId,
                },
              },
            }
          : {}),
      },
      orderBy: [{ scheduled_at: 'asc' }, { created_at: 'desc' }],
      include: {
        _count: {
          select: {
            applications: { where: { status: 'ACCEPTED' } },
          },
        },
      },
    });

    const hasMore = offers.length > limit;
    const data = (hasMore ? offers.slice(0, limit) : offers).map((o) =>
      this.toListItem(o, o._count.applications),
    );
    const nextCursor = hasMore ? (data.at(-1)?.id ?? null) : null;

    return { data, nextCursor };
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
    if (dto.amount < AMOUNT_MIN_FCFA || dto.amount > AMOUNT_MAX_FCFA) {
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
    paymentFlow?: PaymentFlow[];
  }): Promise<{
    data: AdminJobOfferListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, status, paymentFlow } = params;
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
    if (paymentFlow != null && paymentFlow.length > 0) {
      where.payment_flow = { in: paymentFlow };
    }

    const [offers, total] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
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
          a.penalty_amount != null ? Number(a.penalty_amount) : null,
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
      throw new BadRequestException(
        'Only active job offers can be edited',
      );
    }

    const data: Prisma.JobOfferUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description.trim();
    if (dto.scheduledAt !== undefined) data.scheduled_at = new Date(dto.scheduledAt);
    if (dto.amount !== undefined) data.amount = dto.amount;
    if (dto.paymentFlow !== undefined) data.payment_flow = dto.paymentFlow;
    if (dto.address !== undefined) data.address = dto.address.trim();
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;

    const updatedOffer = await this.prisma.jobOffer.update({ where: { id }, data, select: { title: true } });

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
      payment_flow: string;
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
      amount: Number(offer.amount),
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

  /** @deprecated Job posting is free — this method is no longer called. Kept for reference only. */
  private async confirmPaymentByAdmin(
    jobOfferId: string,
    adminUserId: string,
  ): Promise<AdminJobOfferDetailResponse> {
    // Fetch the job offer
    const jobOffer = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      include: {
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
      },
    });

    if (!jobOffer) {
      throw new NotFoundException('Offre d\'emploi introuvable');
    }

    // Verify job is in PENDING_PAYMENT status
    if (jobOffer.status !== JobOfferStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        "L'offre d'emploi n'est pas en attente de paiement",
      );
    }

    // Get job posting fee from system config
    const jobPostingFeeStr = await this.systemConfigService.getRaw(
      'fees.job_posting_fee_fcfa',
      '0',
    );
    const jobPostingFee = Number(jobPostingFeeStr) || 0;

    // Update job offer status to ACTIVE
    const updatedJobOffer = await this.prisma.jobOffer.update({
      where: { id: jobOfferId },
      data: { status: JobOfferStatus.ACTIVE },
      include: {
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
      },
    });

    // Record payment + credit system wallet (atomic via WalletService)
    await this.walletService.recordJobPostingPayment(
      jobOfferId,
      jobOffer.employer_id,
      jobPostingFee,
    );

    // Send WhatsApp notification (fire and forget)
    void this.botNotification
      .sendMessage(
        updatedJobOffer.employer.phone,
        `✅ Votre offre "${updatedJobOffer.title}" est maintenant publiée !\n\nLes travailleurs peuvent désormais y postuler.`,
      )
      .catch((err) => {
        console.error(
          `Failed to send WhatsApp to ${updatedJobOffer.employer.phone}:`,
          err,
        );
      });

    // Send email notification to employer (fire and forget)
    void this.mailService
      .sendMail({
        to: updatedJobOffer.employer.email,
        subject: `Votre offre d'emploi est maintenant active : ${updatedJobOffer.title}`,
        html: `
          <h2>Offre d'emploi activée</h2>
          <p>Bonjour ${updatedJobOffer.employer.first_name},</p>
          <p>Le paiement pour votre offre d'emploi a été confirmé et celle-ci est maintenant active et visible aux candidats.</p>
          <p><strong>Offre:</strong> ${updatedJobOffer.title}</p>
          <p><strong>Montant crédité:</strong> ${jobPostingFee} FCFA</p>
          <p>Les candidats peuvent maintenant postuler à cette offre.</p>
          <br/>
          <p>Cordialement,<br/>L'équipe Rabotka</p>
        `,
      })
      .catch((err) => {
        console.error(`Failed to send email to ${updatedJobOffer.employer.email}:`, err);
      });

    // Return the updated job offer detail
    return {
      id: updatedJobOffer.id,
      title: updatedJobOffer.title,
      description: updatedJobOffer.description,
      scheduledAt: updatedJobOffer.scheduled_at.toISOString(),
      amount: Number(updatedJobOffer.amount),
      paymentFlow: updatedJobOffer.payment_flow,
      address: updatedJobOffer.address,
      note: updatedJobOffer.note,
      quantity: updatedJobOffer.quantity,
      status: updatedJobOffer.status,
      employerName: `${updatedJobOffer.employer.first_name} ${updatedJobOffer.employer.last_name}`.trim(),
      employerEmail: updatedJobOffer.employer.email,
      employerPhone: updatedJobOffer.employer.phone || '',
      employerAvatarUrl: updatedJobOffer.employer.avatar_url,
      employerId: updatedJobOffer.employer.id,
      applicationsCount: updatedJobOffer.applications.length,
      createdAt: updatedJobOffer.created_at.toISOString(),
      updatedAt: updatedJobOffer.updated_at.toISOString(),
      applications: updatedJobOffer.applications.map((app) => ({
        id: app.id,
        workerName: `${app.worker.first_name} ${app.worker.last_name}`.trim(),
        workerEmail: app.worker.email,
        workerPhone: app.worker.phone || '',
        workerAvatarUrl: app.worker.avatar_url,
        workerId: app.worker.id,
        status: app.status,
        penaltyApplied: app.penalty_applied,
        penaltyAmount: app.penalty_amount ? Number(app.penalty_amount) : null,
        cancelledAt: app.cancelled_at?.toISOString() ?? null,
        cancellationReason: app.cancellation_reason,
        createdAt: app.created_at.toISOString(),
      })),
    };
  }
}
