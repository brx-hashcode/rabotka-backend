import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, PaymentMethod, PaymentType, PaymentRequestType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { PAYMENT_QUEUE } from '../../common/services/queue/queue.module';
import { SystemConfigService } from '../system-config/system-config.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';

export type PaymentJobData = {
  paymentId: string;
  type: PaymentType;
  profileId: string;
  amount: number;
  entityId?: string;
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
    private readonly eventEmitter: EventEmitter2,
    private readonly paymentGateway: PaymentGatewayService,
  ) {}

  private getFrontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', '');
  }

  generateActivationPaymentLink(profileId: string): string {
    this.logger.log(
      `Generating activation payment link for profile ${profileId}`,
    );

    return `${this.getFrontendUrl()}/activation/${profileId}`;
  }

  generateJobPostingPaymentLink(jobOfferId: string): string {
    this.logger.log(
      `Generating job posting payment link for job offer ${jobOfferId}`,
    );

    return `${this.getFrontendUrl()}/job-posting/${jobOfferId}`;
  }

  async createPaymentUrl(
    profileId: string,
    amount: number,
    description: string,
    requestType: PaymentRequestType,
    options: {
      contactUnlockAttemptId?: string;
      recommendationWorkerId?: string;
    } = {},
  ): Promise<string> {
    const token = randomUUID();
    await this.prisma.paymentRequest.create({
      data: {
        profile_id: profileId,
        token,
        amount,
        description,
        request_type: requestType,
        ...(options.contactUnlockAttemptId && {
          contact_unlock_attempt_id: options.contactUnlockAttemptId,
        }),
        ...(options.recommendationWorkerId && {
          recommendation_worker_id: options.recommendationWorkerId,
        }),
      },
    });
    return `${this.getFrontendUrl()}/pay/${token}`;
  }

  generatePenaltyPaymentLink(profileId: string, amount: number): string {
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

    try {
      await this.queueService.addJob<PaymentJobData>(PAYMENT_QUEUE, {
        paymentId: payment.id,
        type: data.type,
        profileId: data.profileId,
        amount: data.amount,
        entityId: data.entityId,
      });
    } catch (err) {
      // Roll back the payment record — it would be stuck PENDING forever otherwise
      await this.prisma.payment
        .delete({ where: { id: payment.id } })
        .catch((delErr) =>
          this.logger.error(
            `Failed to roll back payment ${payment.id} after enqueue failure`,
            delErr,
          ),
        );
      throw err;
    }

    return { paymentId: payment.id };
  }

  async initiateDirectPayment(params: {
    profileId: string;
    amount: number;
    phone: string;
    operator: string;
    description: string;
    requestType: PaymentRequestType;
    options?: { contactUnlockAttemptId?: string; recommendationWorkerId?: string };
  }): Promise<{ success: boolean; gatewayRef?: string; error?: string }> {
    const token = randomUUID();
    const paymentRequest = await this.prisma.paymentRequest.create({
      data: {
        profile_id: params.profileId,
        token,
        amount: params.amount,
        description: params.description,
        request_type: params.requestType,
        ...(params.options?.contactUnlockAttemptId && {
          contact_unlock_attempt_id: params.options.contactUnlockAttemptId,
        }),
        ...(params.options?.recommendationWorkerId && {
          recommendation_worker_id: params.options.recommendationWorkerId,
        }),
      },
    });

    try {
      const result = await this.paymentGateway.initiatePayment({
        amount: params.amount,
        currency: 'XAF',
        externalId: paymentRequest.id,
        phone: params.phone,
        description: params.description,
        metadata: { operator: params.operator },
      });

      await this.prisma.paymentRequest.update({
        where: { id: paymentRequest.id },
        data: { gateway_payment_ref: result.gatewayRef },
      });

      return { success: true, gatewayRef: result.gatewayRef };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Gateway error';
      this.logger.error(`initiateDirectPayment failed for ${params.profileId}: ${error}`);
      return { success: false, error };
    }
  }

  async handlePenaltyPaymentSuccess(profileId: string): Promise<void> {
    await this.prisma.penalty.updateMany({
      where: { profile_id: profileId, paid_at: null },
      data: { paid_at: new Date() },
    });

    const remaining = await this.prisma.penalty.count({
      where: { profile_id: profileId, paid_at: null },
    });

    const penaltyProfile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { phone: true, first_name: true, last_name: true },
    });
    const penaltyProfileName = penaltyProfile
      ? `${penaltyProfile.first_name} ${penaltyProfile.last_name}`
      : profileId;

    if (remaining === 0) {
      const updatedProfile = await this.prisma.profile.update({
        where: { id: profileId },
        data: { status: 'ACTIVE' },
        select: { phone: true },
      });

      await this.botNotification.sendMessage(
        updatedProfile.phone,
        `✅ Pénalités réglées — Compte réactivé !\n\nVos pénalités ont été payées avec succès.\nVotre compte Rabotka est de nouveau actif.\n\nVous pouvez maintenant explorer toutes les fonctionnalités.\nTapez n'importe quoi pour commencer.`,
      );
    }

    this.eventEmitter.emit(AdminNotificationEvent.PAYMENT_PENALTY, {
      event: AdminNotificationEvent.PAYMENT_PENALTY,
      title: 'Paiement pénalité',
      message: `Paiement de pénalité réussi pour ${penaltyProfileName}`,
      entityType: 'payment',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });

    this.eventEmitter.emit(AdminNotificationEvent.PENALTY_SOLVED, {
      event: AdminNotificationEvent.PENALTY_SOLVED,
      title: 'Pénalité réglée',
      message: `Les pénalités de ${penaltyProfileName} ont été réglées`,
      entityType: 'penalty',
      entityId: String(profileId),
      timestamp: new Date().toISOString(),
    });

    await this.makePayment({ type: PaymentType.PENALTY, profileId, amount: 0 });
  }
}
