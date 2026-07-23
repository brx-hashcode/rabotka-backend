import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ProfileType } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { FileService } from '../file/file.service';
import { MatchingService } from '../matching/matching.service';
import { CreatePortfolioItemDto } from './dto/create-portfolio-item.dto';
import { UpdatePortfolioItemDto } from './dto/update-portfolio-item.dto';

const PORTFOLIO_FOLDER = 'portfolio';
const MAX_ITEMS_PER_PROFILE = 30;
const MAX_IMAGES_PER_ITEM = 10;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}

export interface PortfolioImageView {
  id: string;
  imageUrl: string;
  position: number;
}

export interface PortfolioItemView {
  id: string;
  title: string;
  description: string;
  position: number;
  createdAt: Date;
  images: PortfolioImageView[];
}

export interface PublicPortfolioView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  reliabilityScore: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  description: string;
  address: string;
  completedMissionsCount: number;
  portfolio: PortfolioItemView[];
}

@Injectable()
export class PortfolioService {
  private readonly logger = new Logger(PortfolioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly storageService: StorageService,
    private readonly matchingService: MatchingService,
  ) {}

  async createItem(
    profileId: string,
    dto: CreatePortfolioItemDto,
    files: Express.Multer.File[],
  ): Promise<PortfolioItemView> {
    if (!files || files.length === 0) {
      throw new BadRequestException('Au moins une image est requise');
    }
    if (files.length > MAX_IMAGES_PER_ITEM) {
      throw new BadRequestException(
        `Maximum ${MAX_IMAGES_PER_ITEM} images par réalisation`,
      );
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, profile_type: true },
    });
    if (!profile) throw new NotFoundException('Profil non trouvé');
    if (profile.profile_type !== ProfileType.WORKER) {
      throw new ForbiddenException(
        'Seuls les travailleurs peuvent créer un portfolio',
      );
    }

    const itemCount = await this.prisma.portfolioItem.count({
      where: { profile_id: profileId },
    });
    if (itemCount >= MAX_ITEMS_PER_PROFILE) {
      throw new BadRequestException(
        `Maximum ${MAX_ITEMS_PER_PROFILE} réalisations par profil`,
      );
    }

    const uploaded = await this.uploadAll(files);

    const item = await this.prisma.portfolioItem.create({
      data: {
        profile_id: profileId,
        title: dto.title,
        description: dto.description,
        position: itemCount,
        images: {
          create: uploaded.map((u, i) => ({
            image_url: u.url,
            storage_key: u.key,
            position: i,
          })),
        },
      },
      include: { images: { orderBy: { position: 'asc' } } },
    });

    await this.ensurePortfolioSlug(profileId);
    this.reindex(profileId);

    return this.toItemView(item);
  }

  async listOwn(profileId: string): Promise<PortfolioItemView[]> {
    const items = await this.prisma.portfolioItem.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    return items.map((item) => this.toItemView(item));
  }

  async updateItem(
    profileId: string,
    itemId: string,
    dto: UpdatePortfolioItemDto,
  ): Promise<PortfolioItemView> {
    await this.assertOwnedItem(profileId, itemId);

    const item = await this.prisma.portfolioItem.update({
      where: { id: itemId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.position !== undefined ? { position: dto.position } : {}),
      },
      include: { images: { orderBy: { position: 'asc' } } },
    });

    if (dto.title !== undefined || dto.description !== undefined) {
      this.reindex(profileId);
    }
    return this.toItemView(item);
  }

  async deleteItem(profileId: string, itemId: string): Promise<void> {
    await this.assertOwnedItem(profileId, itemId);

    const images = await this.prisma.portfolioImage.findMany({
      where: { portfolio_item_id: itemId },
      select: { storage_key: true },
    });
    await this.deleteFromStorage(images.map((img) => img.storage_key));

    // Cascade removes the child image rows.
    await this.prisma.portfolioItem.delete({ where: { id: itemId } });
    this.reindex(profileId);
  }

  async addImages(
    profileId: string,
    itemId: string,
    files: Express.Multer.File[],
  ): Promise<PortfolioItemView> {
    await this.assertOwnedItem(profileId, itemId);
    if (!files || files.length === 0) {
      throw new BadRequestException('Au moins une image est requise');
    }

    const existingCount = await this.prisma.portfolioImage.count({
      where: { portfolio_item_id: itemId },
    });
    if (existingCount + files.length > MAX_IMAGES_PER_ITEM) {
      throw new BadRequestException(
        `Maximum ${MAX_IMAGES_PER_ITEM} images par réalisation`,
      );
    }

    const uploaded = await this.uploadAll(files);
    await this.prisma.portfolioImage.createMany({
      data: uploaded.map((u, i) => ({
        portfolio_item_id: itemId,
        image_url: u.url,
        storage_key: u.key,
        position: existingCount + i,
      })),
    });

    const item = await this.prisma.portfolioItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { images: { orderBy: { position: 'asc' } } },
    });
    return this.toItemView(item);
  }

  async removeImage(
    profileId: string,
    itemId: string,
    imageId: string,
  ): Promise<void> {
    await this.assertOwnedItem(profileId, itemId);

    const image = await this.prisma.portfolioImage.findFirst({
      where: { id: imageId, portfolio_item_id: itemId },
      select: { id: true, storage_key: true },
    });
    if (!image) throw new NotFoundException('Image non trouvée');

    await this.deleteFromStorage([image.storage_key]);
    await this.prisma.portfolioImage.delete({ where: { id: image.id } });
  }

  async getPublicBySlug(slug: string): Promise<PublicPortfolioView> {
    const profile = await this.prisma.profile.findUnique({
      where: { portfolio_slug: slug },
      select: {
        id: true,
        portfolio_slug: true,
        first_name: true,
        last_name: true,
        avatar_url: true,
        reliability_score: true,
        rating_avg: true,
        rating_count: true,
        description: true,
        address: true,
        profile_type: true,
        portfolio_items: {
          orderBy: { created_at: 'desc' },
          include: { images: { orderBy: { position: 'asc' } } },
        },
      },
    });

    if (!profile || profile.profile_type !== ProfileType.WORKER) {
      throw new NotFoundException('Portfolio introuvable');
    }

    const completedMissionsCount = await this.prisma.application.count({
      where: { worker_id: profile.id, status: 'END' },
    });

    return {
      slug,
      firstName: profile.first_name,
      lastName: profile.last_name,
      avatarUrl: profile.avatar_url,
      reliabilityScore: profile.reliability_score,
      ratingAvg: profile.rating_avg,
      ratingCount: profile.rating_count,
      description: profile.description,
      address: profile.address,
      completedMissionsCount,
      portfolio: profile.portfolio_items.map((item) => this.toItemView(item)),
    };
  }

  private async assertOwnedItem(
    profileId: string,
    itemId: string,
  ): Promise<void> {
    const item = await this.prisma.portfolioItem.findFirst({
      where: { id: itemId, profile_id: profileId },
      select: { id: true },
    });
    if (!item) throw new NotFoundException('Réalisation non trouvée');
  }

  private async uploadAll(
    files: Express.Multer.File[],
  ): Promise<Array<{ url: string; key: string }>> {
    const results = await Promise.all(
      files.map((file) =>
        this.fileService.uploadToStorage(file, {
          folder: PORTFOLIO_FOLDER,
          access: 'public',
        }),
      ),
    );
    return results.map((r) => ({ url: r.url, key: r.key }));
  }

  private async deleteFromStorage(keys: Array<string | null>): Promise<void> {
    await Promise.all(
      keys
        .filter((key): key is string => Boolean(key))
        .map((key) =>
          this.storageService.delete(key).catch((err: unknown) => {
            this.logger.warn(
              `Failed to delete portfolio image from storage: ${errorMessage(err)}`,
            );
          }),
        ),
    );
  }

  private reindex(profileId: string): void {
    this.matchingService.indexWorkerProfile(profileId).catch((err: unknown) => {
      this.logger.warn(
        `indexWorkerProfile failed after portfolio change: ${errorMessage(err)}`,
      );
    });
  }

  private async ensurePortfolioSlug(profileId: string): Promise<string> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { portfolio_slug: true, first_name: true, last_name: true },
    });
    if (!profile) throw new NotFoundException('Profil non trouvé');
    if (profile.portfolio_slug) return profile.portfolio_slug;

    const base = this.slugifyName(profile.first_name, profile.last_name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      try {
        const updated = await this.prisma.profile.update({
          where: { id: profileId },
          data: { portfolio_slug: candidate },
          select: { portfolio_slug: true },
        });
        return updated.portfolio_slug!;
      } catch {
        // Unique collision (P2002) — retry with a new suffix.
      }
    }
    // Extremely unlikely fallback: fully random slug.
    const fallback = `${base}-${randomBytes(6).toString('hex')}`;
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { portfolio_slug: fallback },
    });
    return fallback;
  }

  private slugifyName(first: string, last: string): string {
    const base = `${first} ${last}`
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .join('-')
      .slice(0, 40);
    return base || 'travailleur';
  }

  private toItemView(item: {
    id: string;
    title: string;
    description: string;
    position: number;
    created_at: Date;
    images: Array<{ id: string; image_url: string; position: number }>;
  }): PortfolioItemView {
    return {
      id: item.id,
      title: item.title,
      description: item.description,
      position: item.position,
      createdAt: item.created_at,
      images: item.images.map((img) => ({
        id: img.id,
        imageUrl: img.image_url,
        position: img.position,
      })),
    };
  }
}
