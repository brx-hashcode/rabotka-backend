import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import {
  AdStatus,
  Advertisement,
  AdvertisementBundle,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CreateBundleDto, expandBundleChannels } from '../dto/create-bundle.dto';
import { UpdateBundleDto } from '../dto/update-bundle.dto';

@Injectable()
export class AdAdminService {
  private readonly logger = new Logger(AdAdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async approve(id: string): Promise<Advertisement> {
    const ad = await this.prisma.advertisement.findUnique({ where: { id } });
    if (!ad) throw new NotFoundException('Advertisement not found');

    if (ad.status !== AdStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Cannot approve advertisement in status ${ad.status}. Must be PENDING_REVIEW.`,
      );
    }

    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.APPROVED },
    });
  }

  async reject(id: string, reason: string): Promise<Advertisement> {
    const ad = await this.prisma.advertisement.findUnique({ where: { id } });
    if (!ad) throw new NotFoundException('Advertisement not found');

    if (ad.status !== AdStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Cannot reject advertisement in status ${ad.status}. Must be PENDING_REVIEW.`,
      );
    }

    return this.prisma.advertisement.update({
      where: { id },
      data: { status: AdStatus.REJECTED, rejection_reason: reason },
    });
  }

  async listPendingReview(): Promise<Advertisement[]> {
    return this.prisma.advertisement.findMany({
      where: { status: AdStatus.PENDING_REVIEW },
      include: { bundle: true },
      orderBy: { created_at: 'asc' },
    });
  }

  async createBundle(dto: CreateBundleDto): Promise<AdvertisementBundle> {
    return this.prisma.advertisementBundle.create({
      data: {
        name: dto.name,
        description: dto.description,
        price: dto.price,
        currency: dto.currency ?? 'XAF',
        max_reach: dto.maxReach,
        max_frequency_per_week: dto.maxFrequencyPerWeek,
        max_duration_days: dto.maxDurationDays,
        allowed_channels: expandBundleChannels(dto.allowedChannels),
        is_active: dto.isActive ?? true,
      },
    });
  }

  async updateBundle(
    id: string,
    dto: UpdateBundleDto,
  ): Promise<AdvertisementBundle> {
    const bundle = await this.prisma.advertisementBundle.findUnique({
      where: { id },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');

    return this.prisma.advertisementBundle.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description && { description: dto.description }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.currency && { currency: dto.currency }),
        ...(dto.maxReach !== undefined && { max_reach: dto.maxReach }),
        ...(dto.maxFrequencyPerWeek !== undefined && {
          max_frequency_per_week: dto.maxFrequencyPerWeek,
        }),
        ...(dto.maxDurationDays !== undefined && {
          max_duration_days: dto.maxDurationDays,
        }),
        ...(dto.allowedChannels && { allowed_channels: expandBundleChannels(dto.allowedChannels) }),
        ...(dto.isActive !== undefined && { is_active: dto.isActive }),
      },
    });
  }

  async listBundles(): Promise<AdvertisementBundle[]> {
    return this.prisma.advertisementBundle.findMany({
      orderBy: { created_at: 'asc' },
    });
  }

  async deleteBundle(id: string): Promise<void> {
    const bundle = await this.prisma.advertisementBundle.findUnique({
      where: { id },
    });
    if (!bundle) throw new NotFoundException('Bundle not found');

    const hasAds = await this.prisma.advertisement.count({
      where: { bundle_id: id },
    });
    if (hasAds > 0) {
      throw new BadRequestException(
        'Cannot delete a bundle that has advertisements attached to it.',
      );
    }

    await this.prisma.advertisementBundle.delete({ where: { id } });
  }
}
