import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { BotPlatform, MessageDirection } from '@prisma/client';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TwilioService } from '../../common/services/twilio/twilio.service';
import { accountActivationMessage } from './templates';

const VERIFICATION_TOKEN_KEY_PREFIX = 'wa:verify:';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly config: ConfigService,
  ) {}

  isConfigured(): boolean {
    return this.twilioService.isConfigured();
  }

  async sendTextMessage(
    phone: string,
    text: string,
    profileId?: string,
    sentById?: string,
  ): Promise<boolean> {
    const sid = await this.twilioService.sendWhatsApp(phone, text);
    const sent = sid != null;

    if (sent && profileId) {
      await this.saveMessage(
        profileId,
        MessageDirection.OUTBOUND,
        text,
        sentById,
      ).catch((err) =>
        this.logger.warn(
          `Failed to save outbound message for ${profileId}:`,
          err,
        ),
      );
    }

    return sent;
  }

  async sendMediaMessage(
    phone: string,
    mediaUrl: string,
    caption?: string,
  ): Promise<boolean> {
    const sid = await this.twilioService.sendWhatsAppMedia(
      phone,
      mediaUrl,
      caption,
    );
    return sid != null;
  }

  async saveMessage(
    profileId: string,
    direction: MessageDirection,
    body: string,
    sentById?: string,
  ): Promise<void> {
    await this.prisma.message.create({
      data: {
        profile_id: profileId,
        direction,
        platform: BotPlatform.WHATSAPP,
        body,
        ...(sentById ? { sent_by_id: sentById } : {}),
      },
    });
  }

  async verifyWhatsAppToken(token: string): Promise<void> {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Token de vérification invalide');
    }

    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;
    const profileId = await this.redis.get(redisKey);

    if (!profileId) {
      throw new BadRequestException('Token de vérification invalide ou expiré');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        phone: true,
        first_name: true,
      },
    });

    if (!profile) {
      throw new BadRequestException('Profil introuvable');
    }

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { whatsapp_connected: true },
    });

    await this.redis.del(redisKey);

    if (this.isConfigured()) {
      const paymentToken = randomBytes(32).toString('hex');
      const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
      const paymentUrl = `${frontendUrl}/pay/${paymentToken}`;
      const message = accountActivationMessage(paymentUrl);

      await this.sendTextMessage(profile.phone, message, profileId);
    }

    this.logger.log(`WhatsApp verified successfully for profile ${profileId}`);
  }
}
