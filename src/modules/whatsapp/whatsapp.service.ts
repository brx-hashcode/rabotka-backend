import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AccountStatus, BotPlatform, MessageDirection } from '@prisma/client';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TwilioService } from '../../common/services/twilio/twilio.service';
import { WalletService } from '../wallet/wallet.service';
import { welcomeActivationMessage } from './templates';

const VERIFICATION_TOKEN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:verify:`;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly config: ConfigService,
    private readonly walletService: WalletService,
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
        profile_type: true,
      },
    });

    if (!profile) {
      throw new BadRequestException('Profil introuvable');
    }

    // Activate the account
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { whatsapp_connected: true, status: AccountStatus.ACTIVE },
    });

    await this.redis.del(redisKey);

    // Grant welcome credit (idempotent)
    const creditAmount = await this.walletService.grantWelcomeCredit(
      profileId,
      profile.profile_type,
    );

    if (this.isConfigured()) {
      const wallet = await this.walletService
        .getOrCreateProfileWallet(profileId)
        .catch(() => ({ balance: creditAmount }));

      const message = welcomeActivationMessage(
        profile.first_name,
        creditAmount,
        profile.profile_type as 'WORKER' | 'EMPLOYER',
        wallet.balance,
      );
      await this.sendTextMessage(profile.phone, message, profileId);
    }

    this.logger.log(
      `WhatsApp verified and account activated for profile ${profileId}`,
    );
  }
}
