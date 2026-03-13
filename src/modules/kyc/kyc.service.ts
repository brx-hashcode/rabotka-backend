import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botNotification: BotNotificationService,
  ) {}

  async approveKyc(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, phone: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil introuvable');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    await this.prisma.verificationToken.create({
      data: {
        profile_id: profileId,
        token: otp,
        expires_at: expiresAt,
      },
    });

    this.logger.log(`KYC approved for profile ${profileId}, OTP generated`);

    await this.botNotification.sendMessage(
      profile.phone,
      `✅ Votre identité a été vérifiée avec succès !\n\nPour activer votre compte Rabotka, veuillez confirmer votre numéro WhatsApp en tapant le code suivant :\n\n🔑 CODE : ${otp}\n\nCe code expire dans 24 heures.`,
    );
  }
}
