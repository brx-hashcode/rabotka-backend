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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { WhatsAppService } from './whatsapp.service';
import { VerifyWhatsAppDto } from './dto/verify-whatsapp.dto';
import { ConversationService } from '../conversation/conversation.service';
import { TwilioService } from '../../common/services/twilio/twilio.service';

@ApiTags('WhatsApp')
@Controller('whatsapp')
@Public()
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);

  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly conversationService: ConversationService,
    private readonly twilioService: TwilioService,
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
  @ApiResponse({ status: 403, description: 'Invalid signature' })
  async incomingWebhook(
    @Req() req: Request,
    @Body() body: Record<string, string>,
  ): Promise<void> {
    if (!this.twilioService.getAuthToken()) {
      this.logger.warn('TWILIO_AUTH_TOKEN not set; rejecting webhook');
      throw new ForbiddenException('Webhook not configured');
    }

    const signature = req.headers['x-twilio-signature'] as string | undefined;
    if (!signature) {
      throw new ForbiddenException('Missing X-Twilio-Signature');
    }

    const protocol = req.protocol || 'https';
    const host = req.get('host') || '';
    const url = `${protocol}://${host}${req.originalUrl}`;

    const isValid = this.twilioService.validateWebhookSignature(
      signature,
      url,
      body,
    );
    if (!isValid) {
      this.logger.warn('Twilio webhook signature validation failed');
      throw new ForbiddenException('Invalid signature');
    }

    const from = body.From ?? '';
    const text = body.Body ?? '';

    if (!from) {
      throw new BadRequestException('Missing From');
    }

    const phone = from.startsWith('whatsapp:')
      ? from.slice('whatsapp:'.length)
      : from;

    const replies = await this.conversationService.handleIncomingMessage(
      phone,
      text,
    );
    for (const message of replies) {
      if (message) {
        await this.whatsAppService.sendTextMessage(phone, message);
      }
    }
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
        error instanceof Error ? error.message : 'Invalid verification token',
      );
    }
  }
}
