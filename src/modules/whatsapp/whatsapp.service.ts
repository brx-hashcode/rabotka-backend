import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { BotPlatform, MessageDirection } from '@prisma/client';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TwilioService } from '../../common/services/twilio/twilio.service';
import { verificationSuccessMessage } from './templates';

const VERIFICATION_TOKEN_KEY_PREFIX = 'wa:verify:';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  isConfigured(): boolean {
    return this.twilioService.isConfigured();
  }

  async sendTextMessage(
    phone: string,
    text: string,
    profileId?: string,
  ): Promise<boolean> {
    const sid = await this.twilioService.sendWhatsApp(phone, text);
    const sent = sid != null;

    if (sent && profileId) {
      await this.saveMessage(profileId, MessageDirection.OUTBOUND, text).catch(
        (err) =>
          this.logger.warn(`Failed to save outbound message for ${profileId}:`, err),
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
  ): Promise<void> {
    await this.prisma.message.create({
      data: {
        profile_id: profileId,
        direction,
        platform: BotPlatform.WHATSAPP,
        body,
      },
    });
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
      const successMessage = verificationSuccessMessage(profile.first_name);
      await this.sendTextMessage(profile.phone, successMessage, profileId).catch(
        (err) =>
          this.logger.warn(
            `Failed to send WhatsApp success message to ${profile.phone}:`,
            err,
          ),
      );
    }

    this.logger.log(`WhatsApp verified successfully for profile ${profileId}`);
  }
}
