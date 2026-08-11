import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/decorators/public.decorator.js';
import { WHATSAPP_PROVIDER, type WhatsappProvider } from '../contracts';
import { CloudProvider } from '../providers/cloud/cloud.provider';
import type { CloudWebhookBody } from '../providers/cloud/cloud.types';
import { InboundIngestService } from './inbound-ingest.service';
import { normalizeCloudWebhook } from './inbound-normalizer';

/**
 * Meta Cloud webhook.
 *
 * Mounted whichever provider is active. When Cloud is NOT active this returns
 * 200 and drops the payload with a warning: Meta retries aggressively and
 * disables a subscription that keeps failing, so a stale registration must not
 * be answered with an error.
 *
 * Three things about this route are easy to get wrong in this codebase:
 *
 * 1. CSRF. `doubleCsrfProtection` runs on every request and previously exempted
 *    only `/whatsapp/incoming`; without an entry for this path every POST would
 *    get a JSON 403 from middleware and signature verification would never run.
 *    See `skipCsrfProtection` in csrf.module.ts.
 * 2. Throttling. ThrottlerGuard and the Arcjet fixed window are both global and
 *    both allow 100 req/min per IP. Meta batches statuses and retries hard, so
 *    a bulk send could exhaust that budget and turn into a retry storm.
 *    `@SkipThrottle()` — the real limit is per-phone, inside the ingest service.
 * 3. The raw body. The HMAC covers the exact bytes, so `rawBody: true` is set
 *    on the app and the buffer is read from `req.rawBody`.
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp/cloud')
@Public()
@SkipThrottle()
export class CloudWebhookController {
  private readonly logger = new Logger(CloudWebhookController.name);

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsappProvider,
    private readonly ingest: InboundIngestService,
  ) {}

  private get cloud(): CloudProvider | null {
    return this.provider instanceof CloudProvider ? this.provider : null;
  }

  /**
   * Subscription handshake. Meta calls this once when the URL is saved in the
   * app dashboard, and expects the challenge echoed back as plain text — a JSON
   * string (`"12345"` with quotes) is rejected.
   */
  @Get()
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    const cloud = this.cloud;
    if (!cloud) {
      this.logger.warn(
        'Cloud webhook handshake received while WHATSAPP_PROVIDER is not "cloud"',
      );
      throw new ForbiddenException('Cloud provider is not active');
    }
    if (mode !== 'subscribe' || !token || !cloud.verifyChallengeToken(token)) {
      this.logger.warn('Cloud webhook handshake rejected: bad verify token');
      throw new ForbiddenException('Invalid verify token');
    }
    this.logger.log('Cloud webhook handshake accepted');
    return challenge ?? '';
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<void> {
    const cloud = this.cloud;
    if (!cloud) {
      // 200, not 403: an inactive provider is our configuration state, not
      // Meta's fault, and a non-2xx here would have them retry for days.
      this.logger.warn(
        `Cloud webhook received while provider is "${this.provider.name}" — dropped`,
      );
      return;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      // Only reachable if `rawBody: true` was removed from the bootstrap. Loud,
      // because every webhook silently 403s from here on.
      this.logger.error(
        'Cloud webhook has no raw body — NestFactory.create needs { rawBody: true }',
      );
      throw new ForbiddenException('Signature could not be verified');
    }

    if (!cloud.verifyWebhookSignature(rawBody, normalizeHeaders(req.headers))) {
      // "validation failed" on its own is useless: it cannot distinguish a
      // wrong app secret from a body altered in transit, and those need
      // opposite fixes. The three facts below separate them.
      //
      // A body that survived intact has rawBody.length === content-length; a
      // proxy that rewrote or re-encoded it will not. A duplicated
      // X-Hub-Signature-256 (Express joins repeats with ", ") means something
      // ahead of us is signing too. Both are HMAC output or byte counts, so
      // none of this leaks the secret.
      const declared = req.headers['content-length'] ?? 'absent';
      const rawHeader = req.headers['x-hub-signature-256'];
      const count = Array.isArray(rawHeader) ? rawHeader.length : 1;
      const received = normalizeHeaders(req.headers)['x-hub-signature-256'];

      this.logger.warn(
        `Cloud webhook signature validation failed — ` +
          `rawBody=${rawBody.length}B, content-length=${String(declared)}, ` +
          `sigHeaders=${rawHeader ? count : 0}, ` +
          `received=${received ? received.slice(0, 20) : 'none'}…, ` +
          `computed=${cloud.expectedSignaturePreview(rawBody)}…, ` +
          `secret=${cloud.appSecretFingerprint()}`,
      );
      throw new ForbiddenException('Invalid signature');
    }

    const events = normalizeCloudWebhook(readBody(req));
    if (events.length === 0) return;

    await this.ingest.ingest(events);
  }
}

/**
 * Express lowercases header names but types them as
 * `string | string[] | undefined`; the provider wants a flat map.
 */
function normalizeHeaders(headers: Request['headers']): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') flat[key] = value;
    else if (Array.isArray(value) && value.length > 0) flat[key] = value[0];
  }
  return flat;
}

/**
 * The parsed body, or an empty envelope.
 *
 * Meta occasionally posts a shape we do not model (a new field, a webhook for
 * another product on the same app). Normalizing an empty envelope yields no
 * events and a 200, which is the correct answer — a 500 would have them retry
 * something that will never succeed.
 */
function readBody(req: Request): CloudWebhookBody {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null) return {};
  return body as CloudWebhookBody;
}
