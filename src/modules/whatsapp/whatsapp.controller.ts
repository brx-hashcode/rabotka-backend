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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import Redis from 'ioredis';
import { Public } from '../auth/decorators/public.decorator.js';
import { WhatsAppService } from './whatsapp.service';
import { VerifyWhatsAppDto } from './dto/verify-whatsapp.dto';
import { TwilioService } from '../../common/services/twilio/twilio.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { WHATSAPP_INBOUND_QUEUE } from '../../common/services/queue/queue.module';
import type { WhatsAppInboundJobData } from './whatsapp-inbound.processor';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const MSG_IDEMPOTENCY_TTL = 5 * 60; // 5 minutes
const RATE_LIMIT_MAX = 30; // max messages per window
const RATE_LIMIT_WINDOW = 60; // seconds

@ApiTags('WhatsApp')
@Controller('whatsapp')
@Public()
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly twilioService: TwilioService,
    private readonly configService: ConfigService,
    private readonly queueService: QueueService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
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
    if (!this.twilioService.getAuthToken()) {
      this.logger.warn('TWILIO_AUTH_TOKEN not set; rejecting webhook');
      throw new ForbiddenException('Webhook non configuré');
    }

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      throw new ForbiddenException('En-tête X-Twilio-Signature manquant');
    }

    const url = this.buildWebhookUrl(req);

    const isValid = this.twilioService.validateWebhookSignature(
      signature,
      url,
      body,
    );
    if (!isValid) {
      this.logger.warn('Twilio webhook signature validation failed');
      throw new ForbiddenException('Signature invalide');
    }

    // Ignore Twilio delivery status callbacks — real inbound messages have MessageStatus='received'
    const deliveryStatuses = [
      'sent',
      'delivered',
      'read',
      'undelivered',
      'failed',
      'queued',
      'sending',
    ];
    if (body.MessageStatus && deliveryStatuses.includes(body.MessageStatus)) {
      return;
    }

    const from = body.From ?? '';
    const text = body.Body ?? '';
    const messageSid = body.MessageSid ?? '';

    if (!from) {
      throw new BadRequestException("Champ 'From' manquant");
    }

    if (messageSid) {
      const idempotencyKey = `${REDIS_KEY_PREFIX}wa:msg:${messageSid}`;
      const already = await this.redis.set(
        idempotencyKey,
        '1',
        'EX',
        MSG_IDEMPOTENCY_TTL,
        'NX',
      );
      if (already === null) {
        this.logger.debug(`Duplicate webhook ignored: ${messageSid}`);
        return;
      }
    }

    const phone = from.startsWith('whatsapp:')
      ? from.slice('whatsapp:'.length)
      : from;

    this.logger.log(
      `Incoming WhatsApp from ${phone}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
    );

    // Per-phone rate limiting — atomic INCR + EXPIRE NX avoids permanent lock on crash
    const rateLimitKey = `${REDIS_KEY_PREFIX}wa:rate:${phone}`;
    const [[, count]] = (await this.redis
      .pipeline()
      .incr(rateLimitKey)
      .expire(rateLimitKey, RATE_LIMIT_WINDOW, 'NX')
      .exec()) as [[null, number], [null, number]];
    if (count > RATE_LIMIT_MAX) {
      this.logger.warn(`Rate limit exceeded for ${phone}: ${count} msgs/min`);
      return;
    }

    // Enqueue for background processing — the webhook must return fast (<5s)
    // or Twilio will retry, multiplying load.
    await this.queueService.addJob<WhatsAppInboundJobData>(
      WHATSAPP_INBOUND_QUEUE,
      { phone, text, messageSid: messageSid || undefined },
    );
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
