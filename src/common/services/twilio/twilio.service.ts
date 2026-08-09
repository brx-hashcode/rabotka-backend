import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TwilioSDK from 'twilio';
import { SendTimingService } from '../../../modules/whatsapp/telemetry/send-timing.service';

type TwilioClient = ReturnType<typeof TwilioSDK>;
type CreateMessagePayload = Parameters<TwilioClient['messages']['create']>[0];

/**
 * Credentials come from the environment ONLY.
 *
 * They used to be overridable at runtime from `system_config` (with an admin
 * settings card writing them), which meant the process could be sending on
 * credentials that appeared nowhere in its configuration — and made a
 * fail-fast boot check impossible, because the real values arrived after
 * `onModuleInit`. Both providers now validate identically in
 * `whatsapp.config.ts`, and `WHATSAPP_PROVIDER` fail-fast actually means
 * something.
 */
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);

  private client: TwilioClient | null = null;
  private readonly accountSid: string | null;
  private readonly authToken: string | null;
  private readonly whatsappFrom: string | null;
  private readonly smsFrom: string | null;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(SendTimingService)
    private readonly sendTiming?: SendTimingService,
  ) {
    this.accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID') ?? null;
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN') ?? null;
    this.whatsappFrom = this.config.get<string>('TWILIO_WHATSAPP_FROM') ?? null;
    this.smsFrom = this.config.get<string>('TWILIO_SMS_FROM') ?? null;
    this.initClient();
  }

  private initClient(): void {
    if (!this.accountSid || !this.authToken) {
      this.client = null;
      this.logger.warn(
        'Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Twilio sending will be disabled.',
      );
      return;
    }

    try {
      this.client = TwilioSDK(this.accountSid, this.authToken);
      this.logger.log('Twilio client initialized successfully');
    } catch (e) {
      this.logger.error('Failed to initialize Twilio client', e);
      this.client = null;
    }
  }

  isConfigured(): boolean {
    return (
      this.client !== null &&
      this.accountSid !== null &&
      this.authToken !== null
    );
  }

  getAuthToken(): string | null {
    return this.authToken;
  }

  validateWebhookSignature(
    signature: string,
    url: string,
    body: Record<string, string>,
  ): boolean {
    const token = this.getAuthToken();
    if (!token) return false;
    return TwilioSDK.validateRequest(token, signature, url, body);
  }

  private formatWhatsAppNumber(number: string): string {
    if (number.startsWith('whatsapp:')) {
      return number;
    }
    if (number.startsWith('+')) {
      return `whatsapp:${number}`;
    }
    return `whatsapp:+${number}`;
  }

  private getClient(): TwilioClient | null {
    return this.client;
  }

  private async timedCreate(
    client: TwilioClient,
    payload: CreateMessagePayload,
    meta: { to: string; templateSid?: string },
  ): Promise<{ sid: string | null }> {
    const run = () => client.messages.create(payload);
    const message = this.sendTiming
      ? await this.sendTiming.time('twilioAck', 'outbound', meta, run)
      : await run();
    if (message.sid) {
      void this.sendTiming?.markSent(message.sid, meta);
    }
    return message;
  }

  async sendWhatsApp(to: string, body: string): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.whatsappFrom) {
      this.logger.error(
        'Twilio client or WhatsApp sender not configured (set twilio.whatsapp_from in system config and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Cannot send WhatsApp message.',
      );
      return null;
    }

    const toFormatted = this.formatWhatsAppNumber(to);
    const fromFormatted = this.formatWhatsAppNumber(this.whatsappFrom);

    try {
      const message = await this.timedCreate(
        client,
        { from: fromFormatted, to: toFormatted, body },
        { to },
      );
      if (message.sid) {
        this.logger.debug(
          `WhatsApp message sent to ${to}. Message SID: ${message.sid}`,
        );
        return message.sid;
      }
      return null;
    } catch (err) {
      const twilioErr = err as {
        code?: number;
        status?: number;
        message?: string;
      };
      if (twilioErr.code === 63038) {
        this.logger.warn(
          `[Twilio] Daily sandbox limit reached (50 msg/day). Message to ${to} dropped.`,
        );
        throw new Error(
          `[Twilio 63038] Daily sandbox limit reached — message to ${to} dropped`,
        );
      } else if (twilioErr.code === 63031) {
        this.logger.warn(
          `[Twilio] To and From are the same number (${to}). Check webhook/status callback config.`,
        );
        throw new Error(
          `[Twilio 63031] To and From are the same number (${to})`,
        );
      } else {
        this.logger.error(
          `Twilio error sending WhatsApp message to ${to}: [${twilioErr.code ?? twilioErr.status}] ${twilioErr.message}`,
        );
        throw new Error(
          `[Twilio ${twilioErr.code ?? twilioErr.status}] ${twilioErr.message ?? 'Unknown error'} — message to ${to} failed`,
        );
      }
    }
  }

  async sendWhatsAppTemplate(
    to: string,
    contentSid: string,
    contentVariables?: Record<string, string>,
  ): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.whatsappFrom) {
      this.logger.error(
        'Twilio client or WhatsApp sender not configured (set twilio.whatsapp_from in system config and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Cannot send WhatsApp template.',
      );
      return null;
    }

    const toFormatted = this.formatWhatsAppNumber(to);
    const fromFormatted = this.formatWhatsAppNumber(this.whatsappFrom);

    try {
      const message = await this.timedCreate(
        client,
        {
          from: fromFormatted,
          to: toFormatted,
          contentSid,
          ...(contentVariables
            ? { contentVariables: JSON.stringify(contentVariables) }
            : {}),
        },
        { to, templateSid: contentSid },
      );
      if (message.sid) {
        this.logger.debug(
          `WhatsApp template ${contentSid} sent to ${to}. Message SID: ${message.sid}`,
        );
        return message.sid;
      }
      return null;
    } catch (err) {
      const twilioErr = err as {
        code?: number;
        status?: number;
        message?: string;
      };
      this.logger.error(
        `Twilio error sending WhatsApp template ${contentSid} to ${to}: [${twilioErr.code ?? twilioErr.status}] ${twilioErr.message}`,
      );
      throw new Error(
        `[Twilio ${twilioErr.code ?? twilioErr.status}] ${twilioErr.message ?? 'Unknown error'} — template to ${to} failed`,
      );
    }
  }

  async sendWhatsAppMedia(
    to: string,
    mediaUrl: string,
    body?: string,
  ): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.whatsappFrom) {
      this.logger.error(
        'Twilio client or WhatsApp sender not configured (set twilio.whatsapp_from in system config and TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). Cannot send WhatsApp media.',
      );
      return null;
    }

    const toFormatted = this.formatWhatsAppNumber(to);
    const fromFormatted = this.formatWhatsAppNumber(this.whatsappFrom);

    try {
      const payload: {
        from: string;
        to: string;
        mediaUrl: string[];
        body?: string;
      } = {
        from: fromFormatted,
        to: toFormatted,
        mediaUrl: [mediaUrl],
      };
      if (body) payload.body = body;

      const message = await this.timedCreate(client, payload, { to });
      if (message.sid) {
        this.logger.debug(
          `WhatsApp media sent to ${to}. Message SID: ${message.sid}`,
        );
        return message.sid;
      }
      return null;
    } catch (err) {
      const twilioErr = err as {
        code?: number;
        status?: number;
        message?: string;
      };
      if (twilioErr.code === 63038) {
        this.logger.warn(
          `[Twilio] Daily sandbox limit reached (50 msg/day). Media to ${to} dropped.`,
        );
        throw new Error(
          `[Twilio 63038] Daily sandbox limit reached — media to ${to} dropped`,
        );
      } else {
        this.logger.error(
          `Twilio error sending WhatsApp media to ${to}: [${twilioErr.code ?? twilioErr.status}] ${twilioErr.message}`,
        );
        throw new Error(
          `[Twilio ${twilioErr.code ?? twilioErr.status}] ${twilioErr.message ?? 'Unknown error'} — media to ${to} failed`,
        );
      }
    }
  }

  async sendSms(
    to: string,
    body: string,
    from?: string,
  ): Promise<string | null> {
    const client = this.getClient();
    const fromNumber = from ?? this.smsFrom;
    if (!client || !fromNumber) {
      this.logger.error(
        'Twilio client or TWILIO_SMS_FROM not configured. Cannot send SMS.',
      );
      return null;
    }

    try {
      const message = await client.messages.create({
        from: fromNumber,
        to,
        body,
      });
      if (message.sid) {
        this.logger.debug(`SMS sent to ${to}. Message SID: ${message.sid}`);
        return message.sid;
      }
      return null;
    } catch (err) {
      this.logger.error(`Twilio error sending SMS to ${to}:`, err);
      return null;
    }
  }
}
