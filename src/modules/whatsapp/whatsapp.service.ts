import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import TwilioSDK from 'twilio';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';

const VERIFICATION_TOKEN_KEY_PREFIX = 'wa:verify:';

// Type alias - Twilio SDK ReturnType resolves to any, but we need the union with null
type TwilioClient = ReturnType<typeof TwilioSDK>;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  // Workaround: Twilio SDK ReturnType resolves to any, causing ESLint union type error
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- Twilio SDK ReturnType resolves to any
  private client: TwilioClient | null = null;
  private readonly accountSid: string | null;
  private readonly authToken: string | null;
  private readonly whatsappFrom: string | null;
  private readonly smsFrom: string | null;

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID') ?? null;
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN') ?? null;
    this.whatsappFrom = this.config.get<string>('TWILIO_WHATSAPP_FROM') ?? null;
    this.smsFrom = this.config.get<string>('TWILIO_SMS_FROM') ?? null;

    if (!this.accountSid || !this.authToken) {
      this.logger.warn(
        'Twilio credentials not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN). WhatsApp sending will be disabled.',
      );
      return;
    }

    try {
      this.client = TwilioSDK(this.accountSid, this.authToken);
      this.logger.log('Twilio client initialized successfully');
    } catch (e) {
      this.logger.error('Failed to initialize Twilio client', e);
    }
  }

  isConfigured(): boolean {
    return (
      this.client !== null &&
      this.accountSid !== null &&
      this.authToken !== null
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- TwilioClient is ReturnType<typeof TwilioSDK> which resolves to any
  private getClient(): TwilioClient | null {
    return this.client;
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

  async sendTextMessage(phone: string, text: string): Promise<boolean> {
    const client = this.getClient();
    if (!client || !this.whatsappFrom) {
      this.logger.error(
        'Twilio client or TWILIO_WHATSAPP_FROM not configured. Cannot send WhatsApp message.',
      );
      return false;
    }

    const to = this.formatWhatsAppNumber(phone);
    const from = this.formatWhatsAppNumber(this.whatsappFrom);

    try {
      const message = await client.messages.create({
        from,
        to,
        body: text,
      });
      if (message.sid) {
        this.logger.debug(
          `WhatsApp message sent to ${phone}. Message SID: ${message.sid}`,
        );
        return true;
      }
      return false;
    } catch (err) {
      this.logger.error(
        `Twilio error sending WhatsApp message to ${phone}:`,
        err,
      );
      return false;
    }
  }

  async verifyWhatsAppToken(token: string): Promise<void> {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Invalid verification token');
    }

    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;
    const profileId = await this.redis.get(redisKey);

    if (!profileId) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        phone: true,
        first_name: true,
      },
    });

    if (!profile) {
      throw new BadRequestException('Profile not found');
    }

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { whatsapp_connected: true },
    });

    await this.redis.del(redisKey);

    if (this.isConfigured()) {
      const successMessage = `Bonjour ${profile.first_name},

Votre compte WhatsApp a été vérifié avec succès !

Vous pouvez maintenant accéder au menu et utiliser toutes les fonctionnalités de Rabotka.`;

      await this.sendTextMessage(profile.phone, successMessage).catch((err) =>
        this.logger.warn(
          `Failed to send WhatsApp success message to ${profile.phone}:`,
          err,
        ),
      );
    }

    this.logger.log(`WhatsApp verified successfully for profile ${profileId}`);
  }
}
