import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botNotification: BotNotificationService,
  ) {}

  async generateActivationPaymentLink(profileId: string): Promise<string> {
    // TODO: integrate payment provider (CinetPay / Wave / Orange Money)
    this.logger.log(`Generating activation payment link for profile ${profileId}`);
    return `https://pay.rabotka.com/activation/${profileId}`;
  }

  async generateJobPostingPaymentLink(jobOfferId: string): Promise<string> {
    // TODO: integrate payment provider
    this.logger.log(`Generating job posting payment link for job offer ${jobOfferId}`);
    return `https://pay.rabotka.com/job-posting/${jobOfferId}`;
  }

  async generatePenaltyPaymentLink(profileId: string, amount: number): Promise<string> {
    // TODO: integrate payment provider
    this.logger.log(`Generating penalty payment link for profile ${profileId}, amount ${amount}`);
    return `https://pay.rabotka.com/penalties/${profileId}?amount=${amount}`;
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
    // Mark all unpaid penalties as paid
    await this.prisma.penalty.updateMany({
      where: { worker_id: profileId, paid_at: null },
      data: { paid_at: new Date() },
    });

    // Check if any remain
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
