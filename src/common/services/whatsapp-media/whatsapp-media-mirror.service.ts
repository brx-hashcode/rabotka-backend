import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { WHATSAPP_MEDIA_BASE } from '../../constants/whatsapp-carousel';
import { fetchWithTimeout } from '../../utils/fetch-with-timeout.util';

/**
 * WhatsApp carousel templates lock their media field to a single static
 * domain at approval time (Meta only allows variables after the domain —
 * https://www.twilio.com/docs/content/carousel), so an arbitrary external
 * image URL can never be sent as-is. This service accepts any public image
 * URL and makes it template-safe: URLs already on WHATSAPP_MEDIA_BASE map
 * straight to their object key; anything else is downloaded once and
 * re-uploaded to that same R2 bucket under a deterministic key, so repeat
 * calls for the same URL are idempotent and skip re-fetching.
 */
@Injectable()
export class WhatsAppMediaMirrorService {
  private readonly logger = new Logger(WhatsAppMediaMirrorService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string | null;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {
    const accountId = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID');
    const accessKeyId = this.config.get<string>('CLOUDFLARE_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>(
      'CLOUDFLARE_SECRET_ACCESS_KEY',
    );
    this.bucket = this.config.get<string>('CLOUDFLARE_BUCKET_NAME') ?? null;

    if (accountId && accessKeyId && secretAccessKey && this.bucket) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.client = null;
      this.logger.warn(
        'Cloudflare R2 credentials not configured; external media mirroring disabled (falls back to placeholder).',
      );
    }
  }

  /**
   * Resolve any URL to an R2 object key usable in a carousel card's media
   * variable. Falls back to placeholderKey whenever mirroring isn't
   * possible: no url, no R2 credentials, non-http(s) url, fetch failure,
   * non-image content, or upload failure.
   */
  async resolveMediaKey(
    url: string | null | undefined,
    placeholderKey: string,
  ): Promise<string> {
    if (!url) return placeholderKey;
    if (url.startsWith(`${WHATSAPP_MEDIA_BASE}/`)) {
      return url.slice(WHATSAPP_MEDIA_BASE.length + 1);
    }
    if (!this.client || !this.bucket) return placeholderKey;
    if (!/^https?:\/\//i.test(url)) return placeholderKey;

    const key = `mirrored/${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;

    try {
      const alreadyMirrored = await this.client
        .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
        .then(() => true)
        .catch(() => false);
      if (alreadyMirrored) return key;

      const res = await fetchWithTimeout(url, {}, 10_000);
      if (!res.ok) {
        throw new Error(`Fetch failed with status ${res.status}`);
      }
      const contentType =
        res.headers.get('content-type') ?? 'application/octet-stream';
      if (!contentType.startsWith('image/')) {
        throw new Error(`Not an image: ${contentType}`);
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
        }),
      );

      return key;
    } catch (err) {
      this.logger.warn(
        `Failed to mirror external media (${url}): ${(err as Error).message}`,
      );
      return placeholderKey;
    }
  }
}
