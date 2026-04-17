import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  AdStatus,
  AdPaymentStatus,
  Advertisement,
  AdvertisementBundle,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CreateAdvertisementDto } from '../dto/create-advertisement.dto';
import { UpdateAdvertisementDto } from '../dto/update-advertisement.dto';
import { ListAdvertisementsDto } from '../dto/list-advertisements.dto';

const EDITABLE_STATUSES: AdStatus[] = [AdStatus.DRAFT, AdStatus.PAUSED];

const BUNDLE_INCLUDE = {
  bundle: true,
  _count: { select: { delivery_logs: true } },
} as const;

@Injectable()
export class AdvertisementService {
  private readonly logger = new Logger(AdvertisementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateAdvertisementDto): Promise<Advertisement> {
    const bundle = await this.prisma.advertisementBundle.findUnique({
      where: { id: dto.bundleId },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');
    if (!bundle.is_active)
      throw new BadRequestException('Bundle is not active');

    this.validateBundleConstraints(dto, bundle);

    return this.prisma.advertisement.create({
      data: {
        bundle_id: dto.bundleId,
        title: dto.title,
        description: dto.description,
        call_to_action: dto.callToAction,
        cta_url: dto.ctaUrl,
        image_urls: dto.imageUrls ?? [],
        video_url: dto.videoUrl,
        banner_url: dto.bannerUrl,
        logo_url: dto.logoUrl,
        contact_phone: dto.contactPhone,
        contact_email: dto.contactEmail,
        sector: dto.sector,
        advertiser_type: dto.advertiserType,
        language: dto.language ?? 'fr',
        tags: dto.tags ?? [],
        start_date: new Date(dto.startDate),
        end_date: new Date(dto.endDate),
        target_filters: dto.targetFilters
          ? (dto.targetFilters as unknown as Prisma.InputJsonValue)
          : undefined,
        status: AdStatus.DRAFT,
      },
      include: BUNDLE_INCLUDE,
    });
  }

  async findAll(
    filters: ListAdvertisementsDto,
  ): Promise<{ data: Advertisement[]; total: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.AdvertisementWhereInput = {
      ...(filters.status && { status: filters.status }),
    };

    const [data, total] = await Promise.all([
      this.prisma.advertisement.findMany({
        where,
        include: BUNDLE_INCLUDE,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.advertisement.count({ where }),
    ]);

    return { data, total };
  }

  async findOne(id: string): Promise<Advertisement> {
    const ad = await this.prisma.advertisement.findUnique({
      where: { id },
      include: BUNDLE_INCLUDE,
    });
    if (!ad) throw new NotFoundException('Advertisement not found');
    return ad;
  }

  async update(id: string, dto: UpdateAdvertisementDto): Promise<Advertisement> {
    const ad = await this.findOne(id);

    if (!EDITABLE_STATUSES.includes(ad.status)) {
      throw new BadRequestException(
        `Cannot update advertisement in status ${ad.status}. Only DRAFT or PAUSED ads can be modified.`,
      );
    }

    if (dto.bundleId && dto.bundleId !== ad.bundle_id) {
      const bundle = await this.prisma.advertisementBundle.findUnique({
        where: { id: dto.bundleId },
      });
      if (!bundle) throw new NotFoundException('Bundle not found');
      if (!bundle.is_active)
        throw new BadRequestException('Bundle is not active');
      this.validateBundleConstraints(dto as CreateAdvertisementDto, bundle);
    } else if (dto.startDate !== undefined || dto.endDate !== undefined) {
      const bundle = await this.prisma.advertisementBundle.findUnique({
        where: { id: ad.bundle_id },
      });
      if (bundle) {
        this.validateBundleConstraints(
          {
            startDate: dto.startDate ?? ad.start_date.toISOString(),
            endDate: dto.endDate ?? ad.end_date.toISOString(),
          } as CreateAdvertisementDto,
          bundle,
        );
      }
    }

    return this.prisma.advertisement.update({
      where: { id },
      data: {
        ...(dto.bundleId && { bundle_id: dto.bundleId }),
        ...(dto.title && { title: dto.title }),
        ...(dto.description && { description: dto.description }),
        ...(dto.callToAction !== undefined && {
          call_to_action: dto.callToAction,
        }),
        ...(dto.ctaUrl !== undefined && { cta_url: dto.ctaUrl }),
        ...(dto.imageUrls && { image_urls: dto.imageUrls }),
        ...(dto.videoUrl !== undefined && { video_url: dto.videoUrl }),
        ...(dto.bannerUrl !== undefined && { banner_url: dto.bannerUrl }),
        ...(dto.logoUrl !== undefined && { logo_url: dto.logoUrl }),
        ...(dto.contactPhone !== undefined && {
          contact_phone: dto.contactPhone,
        }),
        ...(dto.contactEmail !== undefined && {
          contact_email: dto.contactEmail,
        }),
        ...(dto.sector !== undefined && { sector: dto.sector }),
        ...(dto.advertiserType && { advertiser_type: dto.advertiserType }),
        ...(dto.language && { language: dto.language }),
        ...(dto.tags && { tags: dto.tags }),
        ...(dto.startDate && { start_date: new Date(dto.startDate) }),
        ...(dto.endDate && { end_date: new Date(dto.endDate) }),
        ...(dto.targetFilters !== undefined && {
          target_filters: dto.targetFilters as unknown as Prisma.InputJsonValue,
        }),
      },
      include: BUNDLE_INCLUDE,
    });
  }

  async confirmPayment(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);
    if (ad.payment_status === AdPaymentStatus.PAID) {
      throw new BadRequestException('Payment is already confirmed for this advertisement');
    }
    return this.prisma.advertisement.update({
      where: { id },
      data: { payment_status: AdPaymentStatus.PAID },
      include: BUNDLE_INCLUDE,
    });
  }

  async submit(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);

    if (ad.status !== AdStatus.DRAFT) {
      throw new BadRequestException(
        'Only DRAFT advertisements can be submitted for review',
      );
    }
    if (ad.payment_status !== AdPaymentStatus.PAID) {
      throw new BadRequestException(
        'Advertisement must be paid before submission',
      );
    }

    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.PENDING_REVIEW },
      include: BUNDLE_INCLUDE,
    });
  }

  async pause(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);
    if (ad.status !== AdStatus.ACTIVE) {
      throw new BadRequestException('Only ACTIVE advertisements can be paused');
    }
    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.PAUSED },
      include: BUNDLE_INCLUDE,
    });
  }

  async resume(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);
    if (ad.status !== AdStatus.PAUSED) {
      throw new BadRequestException(
        'Only PAUSED advertisements can be resumed',
      );
    }
    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.APPROVED },
      include: BUNDLE_INCLUDE,
    });
  }

  async cancel(id: string): Promise<Advertisement> {
    const ad = await this.findOne(id);
    if (ad.status === AdStatus.COMPLETED) {
      throw new BadRequestException('Cannot cancel a completed advertisement');
    }
    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.CANCELLED },
      include: BUNDLE_INCLUDE,
    });
  }

  async delete(id: string): Promise<void> {
    await this.findOne(id);
    await this.prisma.advertisement.delete({ where: { id } });
  }

  async updateMetrics(
    id: string,
    field: 'total_sent' | 'total_opened' | 'total_clicks',
  ): Promise<void> {
    await this.prisma.advertisement.update({
      where: { id },
      data: { [field]: { increment: 1 } },
    });
  }

  private validateBundleConstraints(
    dto: Pick<CreateAdvertisementDto, 'startDate' | 'endDate'>,
    bundle: AdvertisementBundle,
  ): void {
    if (dto.startDate && dto.endDate) {
      const start = new Date(dto.startDate);
      const end = new Date(dto.endDate);
      const diffMs = end.getTime() - start.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      if (diffDays < 1) {
        throw new BadRequestException(
          'endDate must be at least 1 day after startDate',
        );
      }
      if (diffDays > bundle.max_duration_days) {
        throw new BadRequestException(
          `Campaign duration (${Math.floor(diffDays)} days) exceeds bundle maximum (${bundle.max_duration_days} days)`,
        );
      }
    }
  }
}
