import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { AccountStatus, JobOfferStatus } from '@prisma/client';

const MIN_SCHEDULED_HOURS_FROM_NOW = 4;
const TITLE_MIN = 5;
const TITLE_MAX = 100;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1000;
const AMOUNT_MIN_FCFA = 1000;
const AMOUNT_MAX_FCFA = 1_000_000;
const ADDRESS_MIN = 10;
const NOTE_MAX = 500;

export type JobOfferListItem = {
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
  created_at: Date;
};

export type JobOfferDetail = JobOfferListItem & {
  employer?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
  };
};

@Injectable()
export class JobOfferService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    employerId: string,
    dto: CreateJobOfferDto,
  ): Promise<JobOfferListItem> {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { id: true, status: true, profile_type: true },
    });
    if (!employer) {
      throw new NotFoundException('Employer not found');
    }
    if (employer.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException('Profile must be active to publish offers');
    }
    if (employer.profile_type !== 'EMPLOYER') {
      throw new ForbiddenException('Only employers can publish job offers');
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
        status: JobOfferStatus.ACTIVE,
      },
    });

    return this.toListItem(offer);
  }

  async findActive(
    limit = 20,
    cursor?: string,
  ): Promise<{
    data: JobOfferListItem[];
    nextCursor: string | null;
  }> {
    const offers = await this.prisma.jobOffer.findMany({
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      where: { status: JobOfferStatus.ACTIVE },
      orderBy: [{ scheduled_at: 'asc' }, { created_at: 'desc' }],
    });

    const hasMore = offers.length > limit;
    const data = (hasMore ? offers.slice(0, limit) : offers).map((o) =>
      this.toListItem(o),
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
          },
        },
      },
    });
    if (!offer) return null;

    return {
      ...this.toListItem(offer),
      employer: offer.employer
        ? {
            id: offer.employer.id,
            first_name: offer.employer.first_name,
            last_name: offer.employer.last_name,
            phone: offer.employer.phone,
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
      throw new NotFoundException('Job offer not found');
    }
    if (offer.employer_id !== actorProfileId) {
      throw new ForbiddenException('Not authorized to update this offer');
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
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
  }

  private toListItem(offer: {
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
    created_at: Date;
  }): JobOfferListItem {
    return {
      id: offer.id,
      title: offer.title,
      description: offer.description,
      scheduled_at: offer.scheduled_at,
      amount: Number(offer.amount),
      payment_flow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      status: offer.status,
      employer_id: offer.employer_id,
      created_at: offer.created_at,
    };
  }
}
