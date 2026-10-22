import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PaymentRequestStatus,
  PaymentStatus,
  PaymentMethod,
  type PaymentRequestType,
  type Prisma,
} from '@prisma/client';
import { resolvePaymentType } from './payment-type';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';
import { LogService } from '../log/log.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import {
  notifyProfile,
  paymentFailedNotification,
} from '../profile-notification/profile-notification.events';

export type PollPaymentStatusJobData = {
  requestId: string;
  token: string;
  gatewayRef: string;
  attempt: number;
  maxAttempts: number;
  intervalMs: number;
  profileId: string;
  amount: number;
  phone?: string;
  operator?: string;
  /**
   * The enum, not a bare `string`.
   *
   * As a string this compared fine against hand-written literals and told
   * nobody when a new member appeared — which is how `WALLET_TOP_UP` was missed
   * here and failed wallet recharges ended up typed as penalties. Typed, the
   * exhaustive switch in `resolvePaymentType` catches the next one at build.
   *
   * Still optional: jobs enqueued before this field existed are already on the
   * queue and deserialise without it.
   */
  requestType?: PaymentRequestType;
  gateway?: string;
};

const MAX_POLL_ATTEMPTS = 48;
const MIN_POLL_INTERVAL_MS = 5_000;

// Minimal interface to break the circular dep: processor → service (without service → processor)
export interface IProcessApprovedPayment {
  processApprovedPaymentById(
    requestId: string,
    transactionId?: string,
    settled?: { amount?: number; currency?: string },
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
    // Appended and optional: the specs construct this processor positionally.
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  setPaymentRequestService(service: IProcessApprovedPayment): void {
    this.paymentRequestService = service;
  }

  async process(job: {
    id?: string;
    data: PollPaymentStatusJobData;
  }): Promise<void> {
    const { requestId, token, gatewayRef, attempt } = job.data;
    const maxAttempts = Math.min(job.data.maxAttempts, MAX_POLL_ATTEMPTS);
    const intervalMs = Math.max(job.data.intervalMs, MIN_POLL_INTERVAL_MS);

    this.logger.log(
      `Poll attempt ${attempt}/${maxAttempts} for request ${requestId} (gatewayRef: ${gatewayRef})`,
    );

    const { status, transactionId, amount, currency } =
      await this.paymentGateway.checkPaymentStatus(gatewayRef);

    if (status === 'COMPLETED') {
      await this.paymentRequestService.processApprovedPaymentById(
        requestId,
        transactionId,
        { amount, currency },
      );
      this.paymentStatusGateway.emitPaymentStatus(token, 'APPROVED');
      return;
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      const rejected = await this.prisma.paymentRequest.updateMany({
        where: this.stillPolledBy(requestId, gatewayRef),
        data: {
          status: PaymentRequestStatus.REJECTED,
          ...(transactionId && { gateway_tx_id: transactionId }),
        },
      });
      if (rejected.count === 0) {
        this.logger.warn(
          `Poll saw ${status} for request ${requestId} but it is no longer in flight under ${gatewayRef} — left as is`,
        );
        return;
      }
      await this.recordFailure(job.data, {
        reason: status === 'FAILED' ? 'GATEWAY_FAILED' : 'GATEWAY_CANCELLED',
        gatewayStatus: status,
        transactionId,
        attempt,
      });
      this.paymentStatusGateway.emitPaymentStatus(token, 'REJECTED');
      // Deduplicated against the webhook, which may settle the same request.
      // Not on the timeout below: that one reverts the request to PENDING.
      notifyProfile(
        this.events,
        paymentFailedNotification({
          id: requestId,
          profile_id: job.data.profileId,
          amount: job.data.amount,
          request_type: job.data.requestType,
        }),
      );
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
    const reverted = await this.prisma.paymentRequest.updateMany({
      where: this.stillPolledBy(requestId, gatewayRef),
      data: { status: PaymentRequestStatus.PENDING },
    });
    if (reverted.count === 0) {
      // Settled meanwhile (webhook) or retried under a new gateway reference:
      // nothing of this attempt is left to time out.
      return;
    }
    await this.recordFailure(job.data, {
      reason: 'POLL_TIMEOUT',
      attempt,
    });
    this.paymentStatusGateway.emitPaymentStatus(token, 'TIMEOUT');
  }

  /**
   * The only row this poll may still write: the same request, still
   * PROCESSING, under the gateway reference this job polls.
   *
   * Pentest A2-NV05 (#881): both writes used to be an unconditional
   * `update({ id })`. A stale PENDING or FAILED read after the webhook had
   * APPROVED the deposit turned it back into PENDING (or REJECTED), reopening
   * a settled payment to be settled again. The webhook and
   * `persistApprovedPayment` already claim with a status predicate; this is
   * the poller's equivalent, plus the reference so an old job cannot touch a
   * retry.
   */
  private stillPolledBy(
    requestId: string,
    gatewayRef: string,
  ): Prisma.PaymentRequestWhereInput {
    return {
      id: requestId,
      status: PaymentRequestStatus.PROCESSING,
      gateway_payment_ref: gatewayRef,
    };
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

    try {
      await this.prisma.payment.create({
        data: {
          // Shares the service's mapping rather than restating it. The version
          // this replaced was `isContactType ? CONTACT_UNLOCK : PENALTY`, which
          // had no WALLET_TOP_UP branch — so a wallet recharge that failed
          // during polling was recorded as a PENALTY and shown to admins as one.
          type: resolvePaymentType(requestType, false, false),
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
}
