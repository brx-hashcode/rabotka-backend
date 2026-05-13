import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import {
  verificationLinkMessage,
  whatsappVerifyPromptMessage,
} from '../whatsapp/templates';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const VERIFICATION_TOKEN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:verify:`;
const VERIFICATION_TOKEN_TTL_SECONDS = 1800;

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async approveKyc(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, first_name: true, phone: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil introuvable');
    }

    const token = randomBytes(8).toString('base64url');
    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;

    await this.redis.set(
      redisKey,
      profileId,
      'EX',
      VERIFICATION_TOKEN_TTL_SECONDS,
    );

    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const verificationLink = `${frontendUrl}/verify/whatsapp?token=${token}`;
    const message = verificationLinkMessage(verificationLink);

    const sent = await this.whatsApp.sendTextMessage(profile.phone, message);

    if (!sent) {
      await this.redis.del(redisKey);
      throw new Error("Echec de l'envoi du message WhatsApp");
    }

    await this.whatsApp
      .sendTextMessage(
        profile.phone,
        whatsappVerifyPromptMessage(profile.first_name),
      )
      .catch(() =>
        this.logger.warn(`Failed to send VERIFIER prompt to ${profile.phone}`),
      );

    this.logger.log(
      `KYC approved for profile ${profileId}, WhatsApp verification link sent`,
    );
  }
}
