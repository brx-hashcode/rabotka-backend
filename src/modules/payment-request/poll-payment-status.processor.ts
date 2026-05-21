import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentRequestStatus,
  PaymentStatus,
  PaymentMethod,
  PaymentType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';
import { LogService } from '../log/log.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { WhatsAppService } from '../whatsapp/whatsapp.service';

export type PollPaymentStatusJobData = {
  requestId: string;
  token: string;
  gatewayRef: string;
  attempt: number;
  maxAttempts: number;
  intervalMs: number;
  // context for audit trail on failure
  profileId: string;
  amount: number;
  phone?: string;
  operator?: string;
  requestType?: string;
  gateway?: string;
};

// Minimal interface to break the circular dep: processor → service (without service → processor)
export interface IProcessApprovedPayment {
  processApprovedPaymentById(
    requestId: string,
    transactionId?: string,
  ): Promise<void>;
}

@Injectable()
export class PollPaymentStatusProcessor {
  private readonly logger = new Logger(PollPaymentStatusProcessor.name);
  private paymentRequestService!: IProcessApprovedPayment;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentStatusGateway: PaymentStatusGateway,
    private readonly queueService: QueueService,
    private readonly logService: LogService,
    private readonly whatsApp: WhatsAppService,
  ) {}

  setPaymentRequestService(service: IProcessApprovedPayment): void {
    this.paymentRequestService = service;
  }

  async process(job: {
    id?: string;
    data: PollPaymentStatusJobData;
  }): Promise<void> {
    const { requestId, token, gatewayRef, attempt, maxAttempts, intervalMs } =
      job.data;

    this.logger.log(
      `Poll attempt ${attempt}/${maxAttempts} for request ${requestId} (gatewayRef: ${gatewayRef})`,
    );

    const { status, transactionId } =
      await this.paymentGateway.checkPaymentStatus(gatewayRef);

    if (status === 'COMPLETED') {
      await this.paymentRequestService.processApprovedPaymentById(
        requestId,
        transactionId,
      );
      this.paymentStatusGateway.emitPaymentStatus(token, 'APPROVED');
      return;
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      await this.prisma.paymentRequest.update({
        where: { id: requestId },
        data: {
          status: PaymentRequestStatus.REJECTED,
          ...(transactionId && { gateway_tx_id: transactionId }),
        },
      });
      await this.recordFailure(job.data, {
        reason: status === 'FAILED' ? 'GATEWAY_FAILED' : 'GATEWAY_CANCELLED',
        gatewayStatus: status,
        transactionId,
        attempt,
      });
      this.paymentStatusGateway.emitPaymentStatus(token, 'REJECTED');
      await this.notifyPaymentFailed(job.data);
      return;
    }

    // Still PENDING — re-enqueue with delay
    if (attempt < maxAttempts) {
      await this.queueService.addJob<PollPaymentStatusJobData>(
        POLL_PAYMENT_STATUS_QUEUE,
        { ...job.data, attempt: attempt + 1 },
        { delay: intervalMs },
      );
      return;
    }

    // All attempts exhausted — revert to PENDING so webhook can still resolve it
    this.logger.warn(
      `Polling timed out for request ${requestId} after ${maxAttempts} attempts — reverting to PENDING`,
    );
    await this.prisma.paymentRequest.update({
      where: { id: requestId },
      data: { status: PaymentRequestStatus.PENDING },
    });
    await this.recordFailure(job.data, {
      reason: 'POLL_TIMEOUT',
      attempt,
    });
    this.paymentStatusGateway.emitPaymentStatus(token, 'TIMEOUT');
    await this.notifyPaymentFailed(job.data);
  }

  private async recordFailure(
    jobData: PollPaymentStatusJobData,
    options: {
      reason: 'GATEWAY_FAILED' | 'GATEWAY_CANCELLED' | 'POLL_TIMEOUT';
      gatewayStatus?: string;
      transactionId?: string;
      attempt: number;
    },
  ): Promise<void> {
    const {
      requestId,
      profileId,
      amount,
      phone,
      operator,
      requestType,
      gateway,
      gatewayRef,
    } = jobData;

    const isContactType =
      requestType === 'CONTACT_UNLOCK' ||
      requestType === 'RECOMMENDATION_CONTACT';

    try {
      await this.prisma.payment.create({
        data: {
          type: isContactType
            ? PaymentType.CONTACT_UNLOCK
            : PaymentType.PENALTY,
          profile_id: profileId,
          amount,
          payment_method: PaymentMethod.MOBILE_MONEY,
          transaction_id: generatePaymentReference(),
          status: PaymentStatus.FAILED,
          description: `Paiement échoué — ${options.reason}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not create FAILED payment record for request ${requestId}`,
        err instanceof Error ? err.message : String(err),
      );
    }

    this.logService
      .create({
        action: 'PAYMENT_FAILED',
        entityType: 'payment_request',
        entityId: requestId,
        profileId,
        metadata: {
          reason: options.reason,
          gatewayStatus: options.gatewayStatus ?? null,
          transactionId: options.transactionId ?? null,
          gatewayRef,
          gateway: gateway ?? null,
          requestType: requestType ?? null,
          amount,
          phone: phone ?? null,
          operator: operator ?? null,
          pollAttempt: options.attempt,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not write PAYMENT_FAILED log for request ${requestId}`,
          err instanceof Error ? err.message : String(err),
        ),
      );

    this.logger.warn(
      `Payment FAILED — request ${requestId} | reason: ${options.reason} | amount: ${amount} FCFA | phone: ${phone ?? 'n/a'} | gatewayRef: ${gatewayRef} | attempt: ${options.attempt}`,
    );
  }

  private async notifyPaymentFailed(
    jobData: PollPaymentStatusJobData,
  ): Promise<void> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: jobData.profileId },
        select: { phone: true },
      });
      if (!profile?.phone) return;

      const amountStr = jobData.amount.toLocaleString('fr-FR');
      const message = [
        `❌ *Paiement échoué*`,
        ``,
        `Votre paiement de *${amountStr} FCFA* via Mobile Money n'a pas abouti.`,
        ``,
        `Vous pouvez réessayer en tapant la commande correspondante, ou choisir un autre mode de paiement.`,
      ].join('\n');

      await this.whatsApp.sendTextMessage(profile.phone, message);
    } catch (err) {
      this.logger.warn(
        `Could not send payment failure WhatsApp notification for request ${jobData.requestId}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
