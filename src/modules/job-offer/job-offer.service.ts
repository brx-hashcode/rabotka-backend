import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService, COLLECTION_JOB_OFFERS } from '../qdrant/qdrant.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { jobOfferPublishedMessage } from '../whatsapp/templates';
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
  private readonly logger = new Logger(JobOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly systemConfig: SystemConfigService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
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
      throw new ForbiddenException(
        'Le profil doit être actif pour publier des offres',
      );
    }
    if (employer.profile_type !== 'EMPLOYER') {
      throw new ForbiddenException(
        "Seuls les employeurs peuvent publier des offres d'emploi",
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
        status: JobOfferStatus.PENDING_PAYMENT,
      },
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
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
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
    const data = (hasMore ? offers.slice(0, limit) : offers)
      .map((o) => this.toListItem(o, o._count.applications))
      .filter((o) => (o.quantity ?? 1) - (o.acceptedCount ?? 0) > 0);
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

    if (status === JobOfferStatus.ACTIVE) {
      this.indexJobOffer(updated).catch((err) =>
        this.logger.error(`Failed to index job offer ${id}`, err),
      );
    } else {
      // Keep Qdrant payload status in sync so similarity search filters stay accurate
      void this.systemConfig.isSimilarityEnabled().then((enabled) => {
        if (!enabled) return;
        this.qdrant
          .setPayload(COLLECTION_JOB_OFFERS, id, { status })
          .catch(() => {
            /* point may not exist yet — safe to ignore */
          });
      });
    }

    return this.toListItem(updated);
  }

  /**
   * Find job offers similar to a worker's profile using vector similarity.
   * Returns up to `limit` active job offer IDs ranked by relevance.
   */
  async findSimilarForWorker(
    workerId: string,
    limit = 10,
  ): Promise<JobOfferListItem[]> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: workerId },
      select: { first_name: true, last_name: true, description: true },
    });
    if (!profile) return [];

    const text =
      `${profile.first_name} ${profile.last_name} ${profile.description}`.trim();
    const vector = await this.qdrant.embed(text);

    const workerVisibleStatuses = [
      JobOfferStatus.ACTIVE,
      JobOfferStatus.PARTIALLY_FILLED,
    ];

    const hits = await this.qdrant.searchSimilar(
      COLLECTION_JOB_OFFERS,
      vector,
      limit,
      {
        must: [
          {
            key: 'status',
            match: { any: workerVisibleStatuses },
          },
        ],
      },
    );

    if (!hits.length) return [];

    const ids = hits.map((h) => String(h.id));
    const offers = await this.prisma.jobOffer.findMany({
      where: {
        id: { in: ids },
        status: { in: workerVisibleStatuses },
        applications: { none: { worker_id: workerId } },
      },
      include: {
        _count: { select: { applications: { where: { status: 'ACCEPTED' } } } },
      },
    });

    // Preserve relevance order
    const offerMap = new Map(offers.map((o) => [o.id, o]));
    return ids
      .map((id) => offerMap.get(id))
      .filter((o): o is NonNullable<typeof o> => o != null)
      .map((o) => this.toListItem(o, o._count.applications))
      .filter((o) => (o.quantity ?? 1) - (o.acceptedCount ?? 0) > 0);
  }

  private async notifyJobOfferPublished(
    offerId: string,
    jobTitle: string,
  ): Promise<void> {
    const employer = await this.prisma.profile.findFirst({
      where: { job_offers: { some: { id: offerId } } },
      select: { id: true, first_name: true, phone: true },
    });
    if (!employer || !this.whatsApp.isConfigured()) return;

    const message = jobOfferPublishedMessage(employer.first_name, jobTitle);
    await this.whatsApp.sendTextMessage(employer.phone, message, employer.id);
  }

  private async indexJobOffer(offer: {
    id: string;
    title: string;
    description: string;
    address: string;
    note: string | null;
    status: string;
    employer_id: string;
    scheduled_at: Date;
    amount: unknown;
    payment_flow: string;
    quantity: number;
  }): Promise<void> {
    if (!(await this.systemConfig.isSimilarityEnabled())) return;

    const parts = [offer.title, offer.description, offer.address];
    if (offer.note) parts.push(offer.note);
    const text = parts.join(' ');

    const vector = await this.qdrant.embed(text);
    await this.qdrant.upsertPoint(COLLECTION_JOB_OFFERS, offer.id, vector, {
      title: offer.title,
      description: offer.description,
      note: offer.note,
      status: offer.status,
      employer_id: offer.employer_id,
      scheduled_at: offer.scheduled_at.toISOString(),
      amount: Number(offer.amount),
      payment_flow: offer.payment_flow,
      quantity: offer.quantity,
    });
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
          a.penalty_amount == null ? null : Number(a.penalty_amount),
        cancelledAt: a.cancelled_at?.toISOString() ?? null,
        cancellationReason: a.cancellation_reason,
        createdAt: a.created_at.toISOString(),
      })),
    };
  }

  async updateJobOfferStatusByAdmin(
    id: string,
    status: JobOfferStatus,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
    });

    if (status === JobOfferStatus.ACTIVE) {
      this.indexJobOffer(updated).catch((err) =>
        this.logger.error(`Failed to index job offer ${id}`, err),
      );
      this.notifyJobOfferPublished(id, updated.title).catch((err) =>
        this.logger.error(`Failed to notify employer for job offer ${id}`, err),
      );
    }

    return this.getJobOfferDetailForAdmin(id);
  }

  async confirmJobPaymentByAdmin(
    id: string,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.status !== JobOfferStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        'Only job offers with PENDING_PAYMENT status can be confirmed',
      );
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status: JobOfferStatus.ACTIVE },
    });

    this.indexJobOffer(updated).catch((err) =>
      this.logger.error(`Failed to index job offer ${id} after payment`, err),
    );
    this.notifyJobOfferPublished(id, updated.title).catch((err) =>
      this.logger.error(`Failed to notify employer for job offer ${id}`, err),
    );

    return this.getJobOfferDetailForAdmin(id);
  }

  async deleteJobOfferByAdmin(id: string): Promise<void> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    await this.prisma.jobOffer.delete({ where: { id } });
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
    if (dto.amount !== undefined) data.amount = dto.amount;
    if (dto.paymentFlow !== undefined) data.payment_flow = dto.paymentFlow;
    if (dto.address !== undefined) data.address = dto.address.trim();
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;

    const updated = await this.prisma.jobOffer.update({ where: { id }, data });

    this.indexJobOffer(updated).catch((err) =>
      this.logger.error(`Failed to re-index job offer ${id}`, err),
    );

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
}
