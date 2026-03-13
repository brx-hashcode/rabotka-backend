import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botNotification: BotNotificationService,
    private readonly config: ConfigService,
  ) {}

  private getFrontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', '');
  }

  async generateActivationPaymentLink(profileId: string): Promise<string> {
    this.logger.log(
      `Generating activation payment link for profile ${profileId}`,
    );

    return `${this.getFrontendUrl()}/activation/${profileId}`;
  }

  async generateJobPostingPaymentLink(jobOfferId: string): Promise<string> {
    this.logger.log(
      `Generating job posting payment link for job offer ${jobOfferId}`,
    );

    return `${this.getFrontendUrl()}/job-posting/${jobOfferId}`;
  }

  async generatePenaltyPaymentLink(
    profileId: string,
    amount: number,
  ): Promise<string> {
    //
    this.logger.log(
      `Generating penalty payment link for profile ${profileId}, amount ${amount}`,
    );

    return `${this.getFrontendUrl()}/penalties/${profileId}?amount=${amount}`;
  }

  async handleActivationPaymentSuccess(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.update({
      where: { id: profileId },
      data: { status: 'ACTIVE' },
    });

    await this.botNotification.sendMessage(
      profile.phone,
      `✅ Votre compte Rabotka est maintenant actif !\n\nBienvenue sur Rabotka 🎉\nVous pouvez dès maintenant explorer toutes les fonctionnalités :\n- Parcourir les offres d'emploi\n- Postuler aux missions\n- Gérer votre profil\n\nTapez n'importe quoi pour commencer.`,
    );
  }

  async handleJobPostingPaymentSuccess(jobOfferId: string): Promise<void> {
    const jobOffer = await this.prisma.jobOffer.update({
      where: { id: jobOfferId },
      data: { status: 'ACTIVE' },
      include: { employer: true },
    });

    await this.botNotification.sendMessage(
      jobOffer.employer.phone,
      `✅ Votre offre "${jobOffer.title}" est maintenant publiée !\n\nLes travailleurs peuvent désormais y postuler.`,
    );
  }

  async handlePenaltyPaymentSuccess(profileId: string): Promise<void> {
    await this.prisma.penalty.updateMany({
      where: { worker_id: profileId, paid_at: null },
      data: { paid_at: new Date() },
    });

    const remaining = await this.prisma.penalty.count({
      where: { worker_id: profileId, paid_at: null },
    });

    if (remaining === 0) {
      const profile = await this.prisma.profile.update({
        where: { id: profileId },
        data: { status: 'ACTIVE' },
      });

      await this.botNotification.sendMessage(
        profile.phone,
        `✅ Pénalités réglées — Compte réactivé !\n\nVos pénalités ont été payées avec succès.\nVotre compte Rabotka est de nouveau actif.\n\nVous pouvez maintenant explorer toutes les fonctionnalités.\nTapez n'importe quoi pour commencer.`,
      );
    }
  }
}
