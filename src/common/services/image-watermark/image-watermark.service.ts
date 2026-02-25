import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'node:path';
import * as fs from 'node:fs';
import sharp from 'sharp';

const DEFAULT_OPACITY = 0.3;
const LOGO_SCALE_FRACTION = 0.2;
const MIN_LOGO_PX = 32;
const MAX_LOGO_PX = 120;

@Injectable()
export class ImageWatermarkService {
  private readonly logger = new Logger(ImageWatermarkService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Overlays the Rabotka logo with configurable opacity onto the image.
   * Non-image mime types are returned unchanged. If the logo file is missing, returns the original buffer.
   */
  async addWatermark(imageBuffer: Buffer, mimeType: string): Promise<Buffer> {
    if (!mimeType?.startsWith('image/')) {
      return imageBuffer;
    }

    const logoPath = this.resolveLogoPath();
    if (!logoPath || !fs.existsSync(logoPath)) {
      this.logger.warn(
        `Watermark logo not found at ${logoPath ?? 'WATERMARK_LOGO_PATH'}; uploading image without watermark`,
      );
      return imageBuffer;
    }

    const opacity = this.getOpacity();

    try {
      const image = sharp(imageBuffer);
      const meta = await image.metadata();
      const width = meta.width ?? 800;
      const height = meta.height ?? 600;

      const logoSize = Math.min(
        Math.max(
          Math.floor(Math.min(width, height) * LOGO_SCALE_FRACTION),
          MIN_LOGO_PX,
        ),
        MAX_LOGO_PX,
      );

      const logoBuffer = await sharp(logoPath)
        .resize(logoSize, logoSize, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const { data, info } = logoBuffer;
      const channels = info.channels;
      if (channels !== 4) {
        this.logger.warn(
          'Logo does not have alpha channel; using full opacity',
        );
      }
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round(data[i] * opacity);
      }

      const overlayWithAlpha = await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: 4,
        },
      })
        .png()
        .toBuffer();

      const format = this.getOutputFormat(mimeType);
      const output = await image
        .composite([
          {
            input: overlayWithAlpha,
            gravity: 'centre',
            blend: 'over',
          },
        ])
        .toFormat(format, this.getFormatOptions(format))
        .toBuffer();

      return output;
    } catch (err) {
      this.logger.warn(
        `Watermark failed, uploading image without watermark: ${err instanceof Error ? err.message : String(err)}`,
      );
      return imageBuffer;
    }
  }

  private resolveLogoPath(): string | null {
    const configured = this.configService.get<string>('WATERMARK_LOGO_PATH');
    if (configured) {
      return path.isAbsolute(configured)
        ? configured
        : path.join(process.cwd(), configured);
    }
    return path.join(process.cwd(), 'assets', 'rabotka-logo.png');
  }

  private getOpacity(): number {
    const raw = this.configService.get<string>('WATERMARK_OPACITY');
    if (raw == null) return DEFAULT_OPACITY;
    const n = Number.parseFloat(raw);
    if (Number.isNaN(n) || n < 0 || n > 1) return DEFAULT_OPACITY;
    return n;
  }

  private getOutputFormat(mimeType: string): keyof sharp.FormatEnum {
    const normalized = mimeType.toLowerCase();
    if (normalized.includes('png')) return 'png';
    if (normalized.includes('webp')) return 'webp';
    return 'jpeg';
  }

  /**
   * Format options to preserve image quality and avoid compression artifacts.
   */
  private getFormatOptions(
    format: keyof sharp.FormatEnum,
  ): Record<string, unknown> {
    switch (format) {
      case 'jpeg':
        return { quality: 95, mozjpeg: true };
      case 'webp':
        return { quality: 95 };
      case 'png':
        return { compressionLevel: 6 };
      default:
        return {};
    }
  }
}
