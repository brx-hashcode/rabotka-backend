import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, PaymentMethod, PaymentType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { PAYMENT_QUEUE } from '../../common/services/queue/queue.module';
import { SystemConfigService } from '../system-config/system-config.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';

export type PaymentJobData = {
  paymentId: string;
  type: PaymentType;
  profileId: string;
  amount: number;
  entityId?: string; // jobOfferId for JOB_POSTING; penaltyId for PENALTY
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botNotification: BotNotificationService,
    private readonly config: ConfigService,
    private readonly queueService: QueueService,
    private readonly systemConfig: SystemConfigService,
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
    this.logger.log(
      `Generating penalty payment link for profile ${profileId}, amount ${amount}`,
    );

    return `${this.getFrontendUrl()}/penalties/${profileId}?amount=${amount}`;
  }

  async makePayment(data: {
    type: PaymentType;
    profileId: string;
    amount: number;
    entityId?: string;
    description?: string;
  }): Promise<{ paymentId: string }> {
    const transactionId = generatePaymentReference();
    const payment = await this.prisma.payment.create({
      data: {
        type: data.type,
        profile_id: data.profileId,
        amount: data.amount,
        payment_method: PaymentMethod.OTHER,
        transaction_id: transactionId,
        status: PaymentStatus.PENDING,
        description: data.description ?? `${data.type} payment`,
      },
    });
    await this.queueService.addJob<PaymentJobData>(PAYMENT_QUEUE, {
      paymentId: payment.id,
      type: data.type,
      profileId: data.profileId,
      amount: data.amount,
      entityId: data.entityId,
    });
    return { paymentId: payment.id };
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

    const fee = await this.systemConfig.getRaw('fees.application_fee_fcfa', '0');
    await this.makePayment({ type: PaymentType.REGISTRATION, profileId, amount: Number(fee) });
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

    const fee = await this.systemConfig.getRaw('fees.job_posting_fee_fcfa', '0');
    await this.makePayment({
      type: PaymentType.JOB_POSTING,
      profileId: jobOffer.employer_id,
      amount: Number(fee),
      entityId: jobOfferId,
    });
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

    await this.makePayment({ type: PaymentType.PENALTY, profileId, amount: 0 });
  }
}
