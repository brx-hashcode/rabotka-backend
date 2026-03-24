import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import TwilioSDK from 'twilio';
import { SystemConfigService } from '../../../modules/system-config/system-config.service';

type TwilioClient = ReturnType<typeof TwilioSDK>;

@Injectable()
export class TwilioService implements OnModuleInit {
  private readonly logger = new Logger(TwilioService.name);

  private client: TwilioClient | null = null;
  private accountSid: string | null;
  private authToken: string | null;
  private whatsappFrom: string | null;
  private smsFrom: string | null;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(forwardRef(() => SystemConfigService)) private readonly systemConfig?: SystemConfigService,
  ) {
    // Initialise from env vars immediately so the service works before onModuleInit
    this.accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID') ?? null;
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN') ?? null;
    this.whatsappFrom = this.config.get<string>('TWILIO_WHATSAPP_FROM') ?? null;
    this.smsFrom = this.config.get<string>('TWILIO_SMS_FROM') ?? null;
    this.initClient();
  }

  async onModuleInit(): Promise<void> {
    if (!this.systemConfig) return;

    try {
      const [sid, token, waFrom, smsFrom] = await Promise.all([
        this.systemConfig.getRaw('twilio.account_sid', ''),
        this.systemConfig.getRaw('twilio.auth_token', ''),
        this.systemConfig.getRaw('twilio.whatsapp_from', ''),
        this.systemConfig.getRaw('twilio.sms_from', ''),
      ]);

      // DB values override env vars only when non-empty
      if (sid) this.accountSid = sid;
      if (token) this.authToken = token;
      if (waFrom) this.whatsappFrom = waFrom;
      if (smsFrom) this.smsFrom = smsFrom;

      const credentialsChanged =
        (sid && sid !== this.config.get('TWILIO_ACCOUNT_SID')) ||
        (token && token !== this.config.get('TWILIO_AUTH_TOKEN'));

      if (credentialsChanged) {
        this.initClient();
        this.logger.log('Twilio client re-initialised from system config (DB)');
      }
    } catch (e) {
      this.logger.warn('Could not load Twilio config from DB, using env vars', e);
    }
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

  async sendWhatsApp(to: string, body: string): Promise<string | null> {
    const client = this.getClient();

    if (!client || !this.whatsappFrom) {
      this.logger.error(
        'Twilio client or TWILIO_WHATSAPP_FROM not configured. Cannot send WhatsApp message.',
      );
      return null;
    }

    const toFormatted = this.formatWhatsAppNumber(to);
    const fromFormatted = this.formatWhatsAppNumber(this.whatsappFrom);

    try {
      const message = await client.messages.create({
        from: fromFormatted,
        to: toFormatted,
        body,
      });
      if (message.sid) {
        this.logger.debug(
          `WhatsApp message sent to ${to}. Message SID: ${message.sid}`,
        );
        return message.sid;
      }
      return null;
    } catch (err) {
      this.logger.error(`Twilio error sending WhatsApp message to ${to}:`, err);
      return null;
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
        'Twilio client or TWILIO_WHATSAPP_FROM not configured. Cannot send WhatsApp media.',
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

      const message = await client.messages.create(payload);
      if (message.sid) {
        this.logger.debug(
          `WhatsApp media sent to ${to}. Message SID: ${message.sid}`,
        );
        return message.sid;
      }
      return null;
    } catch (err) {
      this.logger.error(`Twilio error sending WhatsApp media to ${to}:`, err);
      return null;
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
