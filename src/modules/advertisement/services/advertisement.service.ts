import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  AdStatus,
  AdPaymentStatus,
  FrequencyUnit,
  Advertisement,
  AdvertisementBundle,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CreateAdvertisementDto } from '../dto/create-advertisement.dto';
import { UpdateAdvertisementDto } from '../dto/update-advertisement.dto';
import { ListAdvertisementsDto } from '../dto/list-advertisements.dto';

const EDITABLE_STATUSES: AdStatus[] = [AdStatus.DRAFT, AdStatus.PAUSED];

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
        sector: dto.sector,
        advertiser_type: dto.advertiserType,
        language: dto.language ?? 'fr',
        tags: dto.tags ?? [],
        start_date: new Date(dto.startDate),
        end_date: new Date(dto.endDate),
        frequency_value: dto.frequencyValue,
        frequency_unit: dto.frequencyUnit,
        channel: dto.channel,
        target_reach: dto.targetReach,
        target_audience: dto.targetAudience,
        target_filters: dto.targetFilters
          ? (dto.targetFilters as unknown as Prisma.InputJsonValue)
          : undefined,
        priority: dto.priority,
        status: AdStatus.DRAFT,
      },
      include: { bundle: true },
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
      ...(filters.channel && { channel: filters.channel }),
      ...(filters.targetAudience && {
        target_audience: filters.targetAudience,
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.advertisement.findMany({
        where,
        include: { bundle: true, _count: { select: { delivery_logs: true } } },
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
      include: {
        bundle: true,
        _count: { select: { delivery_logs: true } },
      },
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
    } else if (
      dto.targetReach !== undefined ||
      dto.startDate !== undefined ||
      dto.endDate !== undefined ||
      dto.frequencyValue !== undefined
    ) {
      const bundle = await this.prisma.advertisementBundle.findUnique({
        where: { id: ad.bundle_id },
      });
      if (bundle) {
        this.validateBundleConstraints(
          {
            targetReach: dto.targetReach ?? ad.target_reach,
            startDate: dto.startDate ?? ad.start_date.toISOString(),
            endDate: dto.endDate ?? ad.end_date.toISOString(),
            frequencyValue: dto.frequencyValue ?? ad.frequency_value,
            frequencyUnit: dto.frequencyUnit ?? ad.frequency_unit,
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
        ...(dto.sector !== undefined && { sector: dto.sector }),
        ...(dto.advertiserType && { advertiser_type: dto.advertiserType }),
        ...(dto.language && { language: dto.language }),
        ...(dto.tags && { tags: dto.tags }),
        ...(dto.startDate && { start_date: new Date(dto.startDate) }),
        ...(dto.endDate && { end_date: new Date(dto.endDate) }),
        ...(dto.frequencyValue && { frequency_value: dto.frequencyValue }),
        ...(dto.frequencyUnit && { frequency_unit: dto.frequencyUnit }),
        ...(dto.channel && { channel: dto.channel }),
        ...(dto.targetReach && { target_reach: dto.targetReach }),
        ...(dto.targetAudience && { target_audience: dto.targetAudience }),
        ...(dto.targetFilters !== undefined && {
          target_filters: dto.targetFilters as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.priority && { priority: dto.priority }),
      },
      include: { bundle: true },
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
    });
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
    dto: Pick<
      CreateAdvertisementDto,
      | 'targetReach'
      | 'startDate'
      | 'endDate'
      | 'frequencyValue'
      | 'frequencyUnit'
    >,
    bundle: AdvertisementBundle,
  ): void {
    if (dto.targetReach !== undefined && dto.targetReach > bundle.max_reach) {
      throw new BadRequestException(
        `targetReach (${dto.targetReach}) exceeds bundle maximum (${bundle.max_reach})`,
      );
    }

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

    if (
      dto.frequencyUnit === FrequencyUnit.PER_WEEK &&
      dto.frequencyValue !== undefined &&
      dto.frequencyValue > bundle.max_frequency_per_week
    ) {
      throw new BadRequestException(
        `frequencyValue (${dto.frequencyValue}/week) exceeds bundle maximum (${bundle.max_frequency_per_week}/week)`,
      );
    }
  }
}
