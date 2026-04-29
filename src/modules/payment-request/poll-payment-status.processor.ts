import { Injectable, Logger } from '@nestjs/common';
import { PaymentRequestStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';

export type PollPaymentStatusJobData = {
  requestId: string;
  token: string;
  gatewayRef: string;
  attempt: number;
  maxAttempts: number;
  intervalMs: number;
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
      this.paymentStatusGateway.emitPaymentStatus(token, 'REJECTED');
      return;
    }

    // Still PENDING — re-enqueue with delay
    if (attempt < maxAttempts) {
      await this.queueService.addJob<PollPaymentStatusJobData>(
        POLL_PAYMENT_STATUS_QUEUE,
        { requestId, token, gatewayRef, attempt: attempt + 1, maxAttempts, intervalMs },
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
    this.paymentStatusGateway.emitPaymentStatus(token, 'TIMEOUT');
  }
}
