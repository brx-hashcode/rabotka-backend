import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  BadRequestException,
  ForbiddenException,
  Logger,
  Inject,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator.js';
import { WhatsAppService } from './whatsapp.service';
import { VerifyWhatsAppDto } from './dto/verify-whatsapp.dto';
import { TwilioService } from '../../common/services/twilio/twilio.service';
import { SendTimingInterceptor } from './telemetry/send-timing.interceptor';
import { WHATSAPP_PROVIDER, type WhatsappProvider } from './contracts';
import { InboundIngestService } from './webhooks/inbound-ingest.service';
import { normalizeTwilioWebhook } from './webhooks/inbound-normalizer';

@ApiTags('WhatsApp')
@Controller('whatsapp')
@Public()
// The global ThrottlerGuard and the Arcjet fixed window both allow 100 req/min
// per IP, and a provider's status callbacks share that budget with real inbound
// traffic — a bulk notification run could exhaust it and turn provider retries
// into a storm. The meaningful limit is per-phone, inside InboundIngestService.
@SkipThrottle()
@UseInterceptors(SendTimingInterceptor)
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly twilioService: TwilioService,
    private readonly configService: ConfigService,
    private readonly ingest: InboundIngestService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsappProvider,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'WhatsApp (Twilio) configuration status',
    description:
      'Returns whether Twilio WhatsApp is configured (credentials and from number).',
  })
  @ApiResponse({
    status: 200,
    description: 'Configuration status',
    schema: {
      type: 'object',
      properties: { configured: { type: 'boolean' } },
    },
  })
  getStatus(): { configured: boolean } {
    return { configured: this.whatsAppService.isConfigured() };
  }

  @Post('incoming')
  @ApiOperation({
    summary: 'Twilio WhatsApp webhook',
    description:
      'Receives incoming WhatsApp messages from Twilio. Configure this URL in your Twilio WhatsApp sandbox or number. Validates X-Twilio-Signature.',
  })
  @ApiResponse({ status: 200, description: 'Message handled' })
  @ApiResponse({ status: 403, description: 'Signature invalide' })
  async incomingWebhook(
    @Req() req: Request,
    @Body() body: Record<string, string>,
  ): Promise<void> {
    // Gated on the ACTIVE provider, not on whether credentials happen to exist.
    // Twilio credentials stay in the environment after a flip to Cloud — that
    // is what makes rollback a single variable — so `getAuthToken()` would keep
    // returning a token and this handler would keep processing real traffic
    // from a provider we believe is switched off.
    if (this.provider.name !== 'twilio') {
      this.logger.warn(
        `Twilio webhook received while provider is "${this.provider.name}" — dropped`,
      );
      return;
    }

    if (!this.twilioService.getAuthToken()) {
      this.logger.warn('TWILIO_AUTH_TOKEN not set; rejecting webhook');
      throw new ForbiddenException('Webhook non configuré');
    }

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      throw new ForbiddenException('En-tête X-Twilio-Signature manquant');
    }

    // Twilio signs the parsed form body plus the exact URL it called, so unlike
    // Meta's HMAC this cannot be computed from the raw buffer alone.
    const isValid = this.twilioService.validateWebhookSignature(
      signature,
      this.buildWebhookUrl(req),
      body,
    );
    if (!isValid) {
      this.logger.warn('Twilio webhook signature validation failed');
      throw new ForbiddenException('Signature invalide');
    }

    if (!body.MessageStatus && !body.From) {
      throw new BadRequestException("Champ 'From' manquant");
    }

    // Past this point NOTHING may throw. The signature is verified, so the
    // request is genuine; a 5xx from here would only make the provider replay a
    // message we have already accepted responsibility for, and replays are the
    // problem this pipeline exists to stop.
    //
    // Deliberately after signature verification, not around it: a bad signature
    // must still be a 403.
    //
    // `ingest()` already swallows per-event failures; this covers the
    // normalizer, which can throw on a payload shape we have not seen.
    try {
      // Normalization, rate limiting and the enqueue are shared with the Cloud
      // webhook so the two cannot drift. De-duplication is in the worker.
      await this.ingest.ingest(normalizeTwilioWebhook(body), req.requestId);
    } catch (err) {
      this.logger.error(
        `Twilio webhook processing failed after a valid signature — ` +
          `acknowledged anyway to prevent a replay: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }

  private buildWebhookUrl(req: Request): string {
    const baseUrl = this.configService.get<string>('TWILIO_WEBHOOK_BASE_URL');
    if (baseUrl) {
      const path = req.originalUrl.startsWith('/')
        ? req.originalUrl
        : `/${req.originalUrl}`;
      return baseUrl.replace(/\/$/, '') + path;
    }
    const protocol =
      (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host =
      (req.headers['x-forwarded-host'] as string) || req.get('host') || '';
    return `${protocol}://${host}${req.originalUrl}`;
  }

  @Get('verify')
  @ApiOperation({
    summary: 'Verify WhatsApp token',
    description:
      'Verifies a WhatsApp verification token and links WhatsApp to the user profile. Token must be valid and not expired. Called automatically when user clicks the verification link.',
  })
  @ApiQuery({
    name: 'token',
    type: String,
    description: 'Verification token received via WhatsApp',
    example: 'abc123def456',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'WhatsApp verified successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired token',
  })
  async verifyWhatsApp(
    @Query() verifyWhatsAppDto: VerifyWhatsAppDto,
  ): Promise<{ success: boolean }> {
    try {
      await this.whatsAppService.verifyWhatsAppToken(verifyWhatsAppDto.token);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        error instanceof Error
          ? error.message
          : 'Token de vérification invalide',
      );
    }
  }
}
