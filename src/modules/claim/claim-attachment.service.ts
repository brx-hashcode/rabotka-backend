import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileService } from '../file/file.service';
import { deriveKey } from '../../common/services/storage/kyc-key';
import { storageNames } from '../../common/services/storage/kyc-bucket';
import { SystemConfigService } from '../system-config/system-config.service';
import { withSafeImageName } from '../../common/utils/image-upload.util';
import {
  MAX_CLAIM_ATTACHMENTS,
  isClaimAttachmentKey,
} from './claim-attachment-key';

export type ClaimAttachmentUpload = {
  url: string;
  key: string;
  name: string;
  mimeType: string;
  size: number;
};

/**
 * Uploading claim attachments, and vouching for the urls that come back.
 *
 * A provider of its own rather than more constructor arguments on
 * `ClaimService`: that class is covered by a 750-line spec whose testing module
 * lists every dependency, so each new one edits every describe block in the
 * file. One mock is a cheap price; four would not be.
 */
@Injectable()
export class ClaimAttachmentService {
  constructor(
    private readonly fileService: FileService,
    private readonly config: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  /**
   * Store images and hand back their public urls.
   *
   * `watermark: false` — a claim attachment is evidence, not published work.
   * `addWatermark` re-encodes lossily, which is the opposite of what somebody
   * photographing a defect needs, and the generic `/file/upload` route these
   * replace never watermarked either, so this preserves today's behaviour
   * rather than changing it. Same reasoning as KYC verification images.
   */
  async uploadMany(
    files: Express.Multer.File[],
  ): Promise<ClaimAttachmentUpload[]> {
    if (!files?.length) {
      throw new BadRequestException('Aucun fichier fourni');
    }
    if (files.length > MAX_CLAIM_ATTACHMENTS) {
      throw new BadRequestException(
        `Maximum ${MAX_CLAIM_ATTACHMENTS} images par envoi`,
      );
    }

    return Promise.all(
      files.map(async (file) => {
        const result = await this.fileService.uploadToStorage(
          // Pins the stored key's extension to the validated mime type. Without
          // it the key inherits the client's filename, and `payload.svg` sent
          // as `image/jpeg` would be stored — and then served — as an SVG.
          withSafeImageName(file),
          {
            folder: 'claim-attachments',
            access: 'public',
            watermark: false,
          },
        );

        return {
          url: result.url,
          key: result.key,
          name: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
        };
      }),
    );
  }

  /**
   * Refuse anything that is not an image we ourselves stored for a claim.
   *
   * Called on every write that accepts `attachment_urls`. Before this, the DTO's
   * `@IsString({ each: true })` was the only check, so a caller could persist
   * any url at all — a tracking pixel, a `kyc-documents/` object, or a link to
   * somebody else's private storage — and have both frontends render it.
   */
  async assertValidUrls(urls: string[] | undefined): Promise<void> {
    if (!urls?.length) return;

    if (urls.length > MAX_CLAIM_ATTACHMENTS) {
      throw new BadRequestException(
        `Maximum ${MAX_CLAIM_ATTACHMENTS} pièces jointes`,
      );
    }

    // Resolved once for the whole array: each call hits SystemConfig, and a
    // five-element array would otherwise make five round trips to answer the
    // same question.
    const { publicBaseUrl, buckets } = await storageNames(
      this.systemConfig,
      this.config,
    );

    for (const url of urls) {
      const derived = deriveKey(url, publicBaseUrl, buckets);
      if (!derived || !isClaimAttachmentKey(derived.key)) {
        throw new BadRequestException(
          'Pièce jointe invalide : seules les images envoyées via Rabotka sont acceptées',
        );
      }
    }
  }
}
