import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { JobOfferStatus } from '@prisma/client';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';
import * as QRCode from 'qrcode';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { htmlToImage, htmlToPdf } from '../../../common/utils/puppeteer';
import { withSafeImageName } from '../../../common/utils/image-upload.util';
import { FileService } from '../../file/file.service';
import { businessSiteUrl } from '../../mail/audience';
import { posterHtml, posterSize, type PosterFormat } from './poster';

export const MAX_PHOTOS = 6;
export const MAX_BENEFITS = 8;
export const BENEFIT_MAX = 80;

/**
 * What a business shows of itself on its careers page (cover, photos,
 * benefits), and the printable poster of an offer, with a QR code to apply.
 */
/** Rendered posters, by the hash of their page; a day is plenty for a share. */
const POSTER_CACHE_PREFIX = 'poster:v1:';
const POSTER_CACHE_SECONDS = 24 * 60 * 60;

@Injectable()
export class CareersPageService {
  private readonly logger = new Logger(CareersPageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FileService,
    // Rendered posters, kept a day: a browser launch costs 2 to 4 s.
    @Optional()
    @Inject(REDIS_CONNECTION)
    private readonly redis?: Redis,
  ) {}

  async page(profileId: string) {
    const b = await this.business(profileId);
    return { coverUrl: b.cover_url, photos: b.photos, benefits: b.benefits };
  }

  async setBenefits(profileId: string, benefits: string[]) {
    const clean = [
      ...new Set(benefits.map((x) => x.trim().replace(/\s+/g, ' '))),
    ].filter(Boolean);
    if (clean.length > MAX_BENEFITS) {
      throw new BadRequestException(`${MAX_BENEFITS} avantages au plus.`);
    }
    if (clean.some((x) => x.length > BENEFIT_MAX)) {
      throw new BadRequestException(
        `Un avantage fait ${BENEFIT_MAX} caractères au plus.`,
      );
    }
    await this.business(profileId);
    await this.prisma.business.update({
      where: { profile_id: profileId },
      data: { benefits: clean },
    });
    return this.page(profileId);
  }

  async setCover(profileId: string, file: Express.Multer.File | null) {
    await this.business(profileId);
    const url = file ? await this.upload(file) : null;
    await this.prisma.business.update({
      where: { profile_id: profileId },
      data: { cover_url: url },
    });
    return this.page(profileId);
  }

  async addPhoto(profileId: string, file: Express.Multer.File) {
    const b = await this.business(profileId);
    if (b.photos.length >= MAX_PHOTOS) {
      throw new BadRequestException(`${MAX_PHOTOS} photos au plus.`);
    }
    const url = await this.upload(file);
    await this.prisma.business.update({
      where: { profile_id: profileId },
      data: { photos: { push: url } },
    });
    return this.page(profileId);
  }

  async removePhoto(profileId: string, index: number) {
    const b = await this.business(profileId);
    if (!Number.isInteger(index) || index < 0 || index >= b.photos.length) {
      throw new NotFoundException('Photo introuvable.');
    }
    await this.prisma.business.update({
      where: { profile_id: profileId },
      data: { photos: b.photos.filter((_, i) => i !== index) },
    });
    return this.page(profileId);
  }

  /**
   * The poster of one open offer, its QR code leading to the careers page:
   * an A4 PDF to print, or a PNG sized for a social network.
   */
  async poster(
    profileId: string,
    offerId: string,
    format: PosterFormat = 'a4',
  ) {
    const b = await this.business(profileId);
    const offer = await this.prisma.jobOffer.findFirst({
      where: {
        id: offerId,
        employer_id: profileId,
        deleted_at: null,
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
      },
      select: {
        reference: true,
        title: true,
        description: true,
        employment_type: true,
        scheduled_at: true,
        is_remote: true,
        city: true,
        amount: true,
        payment_flow: true,
      },
    });
    if (!offer) {
      throw new NotFoundException('Seule une offre en ligne a une affiche.');
    }
    if (!b.public_slug) throw new NotFoundException('Page carrières absente.');

    const url = `${businessSiteUrl()}/carrieres/${b.public_slug}/${offer.reference}`;
    const qr = await QRCode.toDataURL(`${url}?source=qr`, {
      margin: 1,
      width: 640,
      errorCorrectionLevel: 'M',
    });
    const html = posterHtml(
      {
        company: b.name,
        logoUrl: b.profile.avatar_url,
        title: offer.title,
        description: offer.description,
        employmentType: offer.employment_type,
        closesAt: offer.scheduled_at,
        place: offer.is_remote ? 'Télétravail' : offer.city,
        amount: offer.amount === null ? null : Number(offer.amount),
        paymentFlow: offer.payment_flow,
        qrDataUrl: qr,
        url: url.replace(/^https?:\/\//, ''),
      },
      format,
    );
    const file =
      format === 'a4'
        ? {
            filename: `affiche-${offer.reference}.pdf`,
            mime: 'application/pdf',
          }
        : {
            filename: `affiche-${offer.reference}-${format}.png`,
            mime: 'image/png',
          };
    // The page drawn says all the poster shows (texts, logo, QR code, size):
    // its hash is the key, so any change is a new render, with nothing to clear.
    const key = `${POSTER_CACHE_PREFIX}${format}:${createHash('sha256').update(html).digest('hex')}`;
    const cached = await this.cachedPoster(key);
    if (cached) return { buffer: cached, ...file };
    try {
      let buffer: Buffer;
      if (format === 'a4') {
        buffer = await htmlToPdf(html, "Offre d'emploi", {
          pageNumbers: false,
          margin: '0',
        });
      } else {
        const { width, height } = posterSize(format);
        buffer = await htmlToImage(html, { width, height: height! });
      }
      await this.keepPoster(key, buffer);
      return { buffer, ...file };
    } catch (err) {
      this.logger.error(`Poster for ${offerId} failed: ${String(err)}`);
      throw err;
    }
  }

  /** A poster drawn before; none when Redis is out of reach (drawn again). */
  private async cachedPoster(key: string): Promise<Buffer | null> {
    try {
      return (await this.redis?.getBuffer(key)) ?? null;
    } catch {
      return null;
    }
  }

  private async keepPoster(key: string, buffer: Buffer): Promise<void> {
    try {
      await this.redis?.set(key, buffer, 'EX', POSTER_CACHE_SECONDS);
    } catch (err) {
      this.logger.warn(`Poster not cached: ${String(err)}`);
    }
  }

  private async upload(file: Express.Multer.File) {
    const { url } = await this.files.uploadToStorage(withSafeImageName(file), {
      folder: 'careers',
      access: 'public',
      // The business's own photos, shown as theirs.
      watermark: false,
    });
    return url;
  }

  private async business(profileId: string) {
    const b = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: {
        name: true,
        public_slug: true,
        cover_url: true,
        photos: true,
        benefits: true,
        profile: { select: { avatar_url: true } },
      },
    });
    if (!b) throw new NotFoundException('Organisation introuvable.');
    return b;
  }
}
