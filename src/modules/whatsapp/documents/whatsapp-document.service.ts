import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { privateBucket } from '../../../common/services/storage/kyc-bucket';
import { SystemConfigService } from '../../system-config/system-config.service';
import { FileService } from '../../file/file.service';
import { WhatsAppService } from '../whatsapp.service';
import type { TemplateKey, TemplateParams } from '../contracts';

/**
 * SystemConfig key gating the whole feature.
 *
 * Ships OFF. The two document templates must be approved at Meta before a
 * single send can succeed, and between merge and approval every send would
 * answer `132001 template name does not exist`. Flipped from
 * admin › configuration système once approval lands.
 */
export const DOCUMENT_DELIVERY_CONFIG_KEY =
  'whatsapp.document_delivery_enabled';

/** Where generated PDFs live in the private bucket. */
const STORAGE_PREFIX = 'whatsapp-documents';

export type WhatsAppDocumentSend<K extends TemplateKey> = {
  phone: string;
  profileId: string;
  template: K;
  /** The template's own params, minus the two this service fills in. */
  params: Omit<TemplateParams<K>, 'documentUrl' | 'documentFilename'>;
  pdf: Buffer;
  /** Name shown in the chat, e.g. `contrat_Okemba_Peinture.pdf`. */
  filename: string;
  /**
   * Object key under the `whatsapp-documents/` prefix, WITHOUT it.
   *
   * Deterministic per document, not per send: a resend overwrites rather than
   * leaving one object behind every time.
   */
  storageKey: string;
};

/**
 * Sends a generated PDF as a real WhatsApp document attachment.
 *
 * Deliberately knows nothing about agreements or contracts — it takes a
 * `Buffer`. `ProfileService` and `ContractService` both live in modules that
 * already import `WhatsAppModule`, so depending on them from here would invert
 * the module graph. The domain modules keep ownership of their own PDFs; what
 * is shared is the plumbing, which is the part that would otherwise be
 * duplicated between the two flows.
 *
 * It lives in its own module for the same kind of reason: it needs
 * `FileModule`, and `FileModule → forwardRef(AuthModule) → forwardRef(
 * WhatsAppModule)` would close a cycle if this sat inside `WhatsAppModule`.
 */
@Injectable()
export class WhatsAppDocumentService {
  private readonly logger = new Logger(WhatsAppDocumentService.name);

  constructor(
    private readonly whatsApp: WhatsAppService,
    private readonly fileService: FileService,
    private readonly config: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  /**
   * Render-free path: upload the PDF, presign it, send the template.
   *
   * Returns `false` when the feature cannot run at all — an unsupported
   * provider or the switch being off — having done NO work in either case.
   * Genuine failures (upload, presign, send) throw, because the caller holds an
   * idempotency claim it has to release.
   */
  async send<K extends TemplateKey>(
    input: WhatsAppDocumentSend<K>,
  ): Promise<boolean> {
    // Asked before anything expensive: on Twilio a document header cannot be
    // expressed at all, and rendering plus uploading a PDF nobody can receive
    // is pure waste.
    if (!this.whatsApp.supports('templateDocumentHeader')) {
      this.logger.debug(
        `Document delivery skipped for ${input.template}: provider has no document-header support`,
      );
      return false;
    }

    if (!(await this.isEnabled())) {
      this.logger.debug(
        `Document delivery skipped for ${input.template}: ${DOCUMENT_DELIVERY_CONFIG_KEY} is off`,
      );
      return false;
    }

    const bucket = await privateBucket(this.systemConfig, this.config);
    const key = `${STORAGE_PREFIX}/${input.storageKey}`;

    // `application/pdf` is not cosmetic: R2 returns it as the Content-Type on
    // the presigned GET, and Meta validates the fetched content type against
    // the template's declared DOCUMENT header format.
    await this.fileService.uploadBuffer(input.pdf, key, {
      mimeType: 'application/pdf',
      access: 'private',
      bucket,
    });

    // Presigned against THE SAME bucket it was written to — signing against the
    // default bucket yields a URL that resolves to nothing, which has happened
    // here before (see the note in `cloudflare-storage.provider.ts`).
    const documentUrl = await this.fileService.getPresignedUrl(key, bucket);

    // The `body` argument becomes the conversation transcript row. `[DOC:…]`
    // mirrors the existing `[IMG:…]` convention and deliberately omits the URL,
    // so a signed credential never lands in the messages table either.
    return this.whatsApp.sendTemplateMessage(
      input.phone,
      input.template,
      {
        ...input.params,
        documentUrl,
        documentFilename: input.filename,
      } as TemplateParams<K>,
      input.profileId,
      `[DOC:${input.filename}]`,
    );
  }

  private async isEnabled(): Promise<boolean> {
    const raw =
      (await this.systemConfig?.get(DOCUMENT_DELIVERY_CONFIG_KEY, '')) ||
      this.config.get<string>('WHATSAPP_DOCUMENT_DELIVERY_ENABLED', '');
    return raw.trim().toLowerCase() === 'true';
  }
}
