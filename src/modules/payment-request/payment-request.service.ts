import {
  CFA_CURRENCIES,
  toAlpha3,
} from '../../common/services/payment/payment-countries';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  BillingStatus,
  ContactRecordOrigin,
  InvoiceReason,
  PaymentMethod,
  PaymentRequestStatus,
  PaymentRequestType,
  PaymentStatus,
  PaymentType,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  notifyProfile,
  paymentFailedNotification,
} from '../profile-notification/profile-notification.events';
import {
  paymentKindOf,
  personName,
} from '../profile-notification/notification-catalog';
import { resolvePaymentType } from './payment-type';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ContactRecordService } from '../contact-unlock/contact-record.service';
import { deletedAtFilter } from '../../common/utils/soft-delete.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppFeedbackService } from '../whatsapp/feedback/whatsapp-feedback.service';
import { ReferralService } from '../referral/referral.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { invoiceEmail, paymentSuccessEmail } from '../mail/templates';
import { audienceOf, productOf } from '../mail/audience';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import type {
  PaymentGatewayMetadata,
  PaymentOperatorMetadata,
} from '../../common/services/payment/types/payment-gateway.types';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { formatPenaltyPaidSuccess } from '../bot/messages/penalty.messages';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import { InvoiceService } from '../invoice/invoice.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { LogService } from '../log/log.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';
import type { PollPaymentStatusJobData } from './poll-payment-status.processor';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';
import { SubmitPaymentDto } from './dto/submit-payment.dto';
import { CONTACTABLE_WORKER } from '../recommendation/contactable-worker';

const PAYMENT_REQUEST_SELECT = {
  id: true,
  created_at: true,
  updated_at: true,
  profile_id: true,
  token: true,
  status: true,
  payment_reference: true,
  proof_images: true,
  rejection_note: true,
  amount: true,
  description: true,
  phone: true,
  operator: true,
  gateway: true,
  gateway_payment_ref: true,
  request_type: true,
  recommendation_worker_id: true,
  contact_unlock_attempt_id: true,
  penalty_ids: true,
  profile: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      status: true,
      profile_type: true,
      is_business: true,
      country_code: true,
    },
  },
} as const;

type PaymentRequestWithProfile = Prisma.PaymentRequestGetPayload<{
  select: typeof PAYMENT_REQUEST_SELECT;
}>;

type PaymentProcessingContext = {
  amount: number;
  transactionRef: string;
  isContactUnlock: boolean;
  isRecommendationContact: boolean;
  recommendationWorkerId: string | null;
  paymentType: PaymentType;
  paymentDescription: string;
};

// Moved to `payment-type.ts` so the poll processor writes the same mapping this
// service does. It could not import it from here — the processor keeps a
// hand-written interface to break exactly that cycle — so it open-coded the
// rule instead, missed WALLET_TOP_UP, and filed failed wallet recharges as
// penalties.

/** Requests are priced in CFA francs; either franc can be charged (see CFA_CURRENCIES). */
const PAYMENT_CURRENCIES = CFA_CURRENCIES;

@Injectable()
export class PaymentRequestService {
  private readonly logger = new Logger(PaymentRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly systemConfig: SystemConfigService,
    private readonly walletService: WalletService,
    private readonly whatsAppService: WhatsAppService,
    private readonly mailService: MailService,
    private readonly layoutService: LayoutService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentStatusGateway: PaymentStatusGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly botNotification: BotNotificationService,
    private readonly contactUnlockService: ContactUnlockService,
    private readonly invoiceService: InvoiceService,
    private readonly queueService: QueueService,
    private readonly logService: LogService,
    // Appended, not slotted in beside `whatsAppService` where it reads better:
    // the specs construct this service positionally, and inserting a parameter
    // mid-list silently shifts fourteen mocks by one.
    private readonly feedback: WhatsAppFeedbackService,
    private readonly referralService: ReferralService,
    // Appended for the same reason as `feedback` above: positional mocks.
    private readonly contactRecords: ContactRecordService,
  ) {}

  /**
   * Creates a payment request token for the given profile and returns
   * the public payment URL. Now requires amount + description.
   */
  async createPaymentUrl(
    profileId: string,
    amount: number,
    description: string,
    requestType: PaymentRequestType,
    options: {
      contactUnlockAttemptId?: string;
      recommendationWorkerId?: string;
      /** For a penalty request: the penalties its amount was priced for. */
      penaltyIds?: string[];
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
        ...(options.penaltyIds?.length && { penalty_ids: options.penaltyIds }),
      },
    });
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    return `${frontendUrl}/pay/${token}`;
  }

  async getByProfileId(profileId: string) {
    const requests = await this.prisma.paymentRequest.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      select: PAYMENT_REQUEST_SELECT,
    });
    return requests.map((r) => this.formatRequest(r));
  }

  async getByToken(token: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    const isSettled =
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED;

    if (isSettled) {
      throw new BadRequestException('Cette demande a déjà été traitée');
    }

    const activeGateway = this.config.get<string>('PAYMENT_GATEWAY_DRIVER');
    if (!activeGateway)
      throw new Error(
        'PAYMENT_GATEWAY_DRIVER env var is required but not set.',
      );

    return {
      id: request.id,
      status: request.status,
      gateway: activeGateway,
      profileName: this.fullName(request.profile),
      amount: request.amount === null ? null : Number(request.amount),
      description: request.description ?? null,
      // The payer's country (ISO3), so the page offers that country's
      // networks only. Null when the profile has no country we can map.
      payerCountry: toAlpha3(request.profile?.country_code),
      // The profile's own ISO alpha-2 code, so the page can find the
      // payer's country among the gateway's live ones by calling code.
      payerCountryCode: request.profile?.country_code ?? null,
    };
  }

  /**
   * The gateways this build knows about, and which one is live.
   *
   * Consumers render from this instead of keeping their own name tables, so a
   * new provider shows up in the payment page and the admin without either of
   * them being redeployed with a new constant.
   */
  async listGateways(): Promise<{
    /** Null when payments are disabled (no usable gateway configured). */
    active: string | null;
    gateways: PaymentGatewayMetadata[];
  }> {
    const active = this.paymentGateway.getActiveMetadataOrNull();
    // The live gateway's networks are what its account can charge in our
    // currency today, read from the provider — not a list kept in code.
    const liveOperators = active
      ? await this.paymentGateway.activeOperators(PAYMENT_CURRENCIES)
      : [];
    return {
      active: active?.key ?? null,
      gateways: this.paymentGateway
        .listAvailable()
        .map((g) =>
          g.key === active?.key ? { ...g, operators: liveOperators } : g,
        ),
    };
  }

  /**
   * The DTO can only confirm the operator is a code *some* gateway knows;
   * whether it fits the one this deployment runs on is a runtime question.
   * Sending pawaPay's `AIRTEL_COG` to MTN MoMo would otherwise be accepted
   * here and rejected by the gateway, after the request had already been
   * claimed PROCESSING.
   */
  /** The network to charge, checked against the number — null for a gateway that does not route by network. */
  private async assertOperatorMatchesGateway(
    operator: string | undefined,
    phone: string,
  ): Promise<PaymentOperatorMetadata | null> {
    const gateway = this.paymentGateway.getActiveMetadata();

    if (!gateway.requiresOperator) return null;

    const operators =
      await this.paymentGateway.activeOperators(PAYMENT_CURRENCIES);
    const network = operators.find((o) => o.code === operator);
    if (!operator || !network) {
      throw new BadRequestException(
        `Opérateur invalide pour ${gateway.label}. Valeurs acceptées : ${operators
          .map((o) => o.code)
          .join(', ')}`,
      );
    }

    // The number decides which country's networks can charge it — someone
    // living in Congo may pay with a Cameroonian number. Its international
    // prefix must be the network's country's; a local number without one is
    // put in that country's form by the gateway, so it cannot disagree.
    const trimmed = phone.trim();
    const international = trimmed.startsWith('+') || trimmed.startsWith('00');
    if (international && network.dialCode) {
      let digits = trimmed.replace(/\D/g, '');
      if (trimmed.startsWith('00')) digits = digits.slice(2);
      if (!digits.startsWith(network.dialCode)) {
        throw new BadRequestException(
          'Cet opérateur ne correspond pas au pays de ce numéro.',
        );
      }
    }
    return network;
  }

  /**
   * Initiates a mobile-money push for the given token on the active gateway.
   * Updates the PaymentRequest to PROCESSING status.
   */
  async initiatePayment(
    token: string,
    phone: string,
    operator: string,
  ): Promise<{ success: boolean }> {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
      include: {
        profile: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            profile_type: true,
            country_code: true,
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (!request.amount) {
      throw new BadRequestException('Montant non défini pour cette demande');
    }

    await this.assertPenaltiesStillOwed(request);

    const network = await this.assertOperatorMatchesGateway(operator, phone);

    // Atomically claim PENDING → PROCESSING before calling the gateway.
    // Concurrent double-taps both attempt this; only one succeeds (count === 1).
    const locked = await this.prisma.paymentRequest.updateMany({
      where: { id: request.id, status: PaymentRequestStatus.PENDING },
      data: { status: PaymentRequestStatus.PROCESSING, phone, operator },
    });

    if (locked.count === 0) {
      throw new BadRequestException(
        "Cette demande n'est pas en attente de paiement",
      );
    }

    const profileName = request.profile
      ? `${request.profile.first_name} ${request.profile.last_name}`.trim()
      : 'Utilisateur';

    let gatewayRef: string;
    try {
      const result = await this.paymentGateway.initiatePayment({
        amount: Number(request.amount),
        // The network's own franc: XOF in Bénin, XAF in Congo — same amount.
        currency: network?.currency ?? 'XAF',
        externalId: request.id,
        phone,
        operator,
        description: request.description ?? undefined,
        requestType: request.request_type,
        // Who pays, for the gateway's records (pawaPay keeps it as metadata,
        // flagging what identifies the person).
        payer: request.profile
          ? {
              profileId: request.profile.id,
              name: profileName,
              email: request.profile.email,
              profileType: request.profile.profile_type,
            }
          : undefined,
      });
      gatewayRef = result.gatewayRef;
    } catch (err) {
      // Revert to PENDING so the user can retry
      await this.prisma.paymentRequest.updateMany({
        where: { id: request.id, status: PaymentRequestStatus.PROCESSING },
        data: {
          status: PaymentRequestStatus.PENDING,
          phone: null,
          operator: null,
        },
      });
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Échec de l'initiation du paiement";
      this.logger.warn(
        `Gateway init failed for request ${request.id} — profile: ${profileName} | phone: ${phone} | amount: ${Number(request.amount)} FCFA | error: ${errorMessage}`,
      );
      this.logService
        .create({
          action: 'PAYMENT_GATEWAY_INIT_FAILED',
          entityType: 'payment_request',
          entityId: request.id,
          profileId: request.profile_id,
          metadata: {
            reason: 'GATEWAY_INIT_ERROR',
            errorMessage,
            amount: Number(request.amount),
            phone,
            operator,
            profileName,
            requestType: request.request_type ?? null,
          },
        })
        .catch((logErr: unknown) =>
          this.logger.warn(
            `Could not write PAYMENT_GATEWAY_INIT_FAILED log for request ${request.id}`,
            logErr instanceof Error ? logErr.message : String(logErr),
          ),
        );
      throw new BadRequestException(errorMessage);
    }

    const activeGateway = this.config.get<string>('PAYMENT_GATEWAY_DRIVER');
    if (!activeGateway)
      throw new Error(
        'PAYMENT_GATEWAY_DRIVER env var is required but not set.',
      );

    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        gateway: activeGateway,
        gateway_payment_ref: gatewayRef || null,
      },
    });

    if (gatewayRef) {
      await this.queueService.addJob<PollPaymentStatusJobData>(
        POLL_PAYMENT_STATUS_QUEUE,
        {
          requestId: request.id,
          token: request.token,
          gatewayRef,
          attempt: 1,
          maxAttempts: 24,
          intervalMs: 5000,
          profileId: request.profile_id,
          amount: Number(request.amount),
          phone,
          operator,
          requestType: request.request_type ?? undefined,
          gateway: activeGateway,
        },
        { delay: 5000 },
      );
    }

    return { success: true };
  }

  /**
   * Handles a payment gateway webhook callback.
   * Delegates payload parsing and status verification to the active gateway.
   * On success: credits system wallet, sends notifications, pushes WebSocket update.
   * On failure: marks rejected, pushes WebSocket update.
   */
  async handlePaymentCallback(
    payload: Record<string, string>,
  ): Promise<{ received: boolean }> {
    const { gatewayRef, status, transactionId, amount, currency } =
      await this.paymentGateway.handleWebhookPayload(payload);

    if (typeof gatewayRef !== 'string' || !gatewayRef) {
      this.logger.warn('Payment callback missing gatewayRef');
      return { received: true };
    }

    const request = await this.prisma.paymentRequest.findFirst({
      where: { gateway_payment_ref: gatewayRef },
      select: { ...PAYMENT_REQUEST_SELECT, gateway_payment_ref: true },
    });

    if (!request) {
      this.logger.warn(`Payment callback: gatewayRef not found: ${gatewayRef}`);
      return { received: true };
    }

    if (
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      return { received: true };
    }

    // status and transactionId already re-verified by the gateway's handleWebhookPayload
    if (status === 'COMPLETED') {
      if (await this.settlementMismatch(request, { amount, currency })) {
        return { received: true };
      }
      await this.processSuccessfulPayment(request, transactionId);
      this.paymentStatusGateway.emitPaymentStatus(request.token, 'APPROVED');
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      // Atomic claim — only the first concurrent webhook proceeds with side effects
      const claimed = await this.prisma.paymentRequest.updateMany({
        where: {
          id: request.id,
          status: {
            notIn: [
              PaymentRequestStatus.APPROVED,
              PaymentRequestStatus.REJECTED,
            ],
          },
        },
        data: {
          status: PaymentRequestStatus.REJECTED,
          ...(transactionId && { gateway_tx_id: transactionId }),
        },
      });
      if (claimed.count === 0) {
        return { received: true };
      }
      await this.persistFailedPayment(request, {
        reason: status === 'FAILED' ? 'GATEWAY_FAILED' : 'GATEWAY_CANCELLED',
        gatewayStatus: status,
        transactionId,
        gatewayRef,
      });
      this.paymentStatusGateway.emitPaymentStatus(request.token, 'REJECTED');
      // In-app only: a WhatsApp text here duplicated the poller's.
      notifyProfile(this.eventEmitter, paymentFailedNotification(request));
    } else {
      this.logger.warn(
        `Payment callback for ${gatewayRef} re-verified as PENDING — no action taken`,
      );
    }

    return { received: true };
  }

  async processApprovedPaymentById(
    requestId: string,
    transactionId?: string,
    settled?: { amount?: number; currency?: string },
  ): Promise<void> {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: requestId },
      select: { ...PAYMENT_REQUEST_SELECT, gateway_payment_ref: true },
    });
    if (
      !request ||
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      return;
    }
    if (settled && (await this.settlementMismatch(request, settled))) return;
    await this.processSuccessfulPayment(request, transactionId);
  }

  /**
   * Whether the gateway settled something other than what was asked. A
   * gateway that does not report the amount (MTN MoMo) is not checked.
   *
   * A mismatch is not approved and not rejected: the money did move, so the
   * request stays PROCESSING for someone to look at, and the audit log says
   * why.
   */
  private async settlementMismatch(
    request: {
      id: string;
      amount: unknown;
      gateway_payment_ref?: string | null;
    },
    settled: { amount?: number; currency?: string },
  ): Promise<boolean> {
    const expected = Math.round(Number(request.amount));
    const amountOff =
      settled.amount !== undefined && Math.round(settled.amount) !== expected;
    // Either CFA franc: same value, so the same amount is right in both.
    const currencyOff =
      settled.currency !== undefined &&
      !(PAYMENT_CURRENCIES as readonly string[]).includes(settled.currency);
    if (!amountOff && !currencyOff) return false;

    this.logger.warn(
      `Payment ${request.id} settled ${settled.amount ?? '?'} ${settled.currency ?? '?'} instead of ${expected} XAF — not approved`,
    );
    await this.logService
      .create({
        action: 'PAYMENT_AMOUNT_MISMATCH',
        entityType: 'payment_request',
        entityId: request.id,
        metadata: {
          expected: { amount: expected, currency: 'XAF' },
          settled,
          gatewayRef: request.gateway_payment_ref ?? null,
        },
      })
      .catch(() => undefined);
    return true;
  }

  private async processSuccessfulPayment(
    request: PaymentRequestWithProfile,
    transactionId?: string,
  ): Promise<void> {
    const context = await this.buildPaymentProcessingContext(request);
    const claimed = await this.persistApprovedPayment(
      request,
      context,
      transactionId,
    );

    if (!claimed) {
      this.logger.warn(
        `Payment ${request.id} already processed by another thread — skipping side-effects`,
      );
      return;
    }

    this.logger.log(
      `Payment approved: ${request.id} — ${context.amount} FCFA credited to system wallet`,
    );

    // After the atomic claim, so the webhook and the poller cannot both add one.
    notifyProfile(this.eventEmitter, {
      recipientId: request.profile_id,
      input: {
        type: 'PAYMENT_SUCCEEDED',
        amount: context.amount,
        kind: paymentKindOf(request.request_type),
      },
    });

    this.emitAdminPaymentNotification(request, context);
    await this.handlePenaltyPostPayment(request);
    await this.handleWalletTopUpPostPayment(request, context);

    // Compute unlock result first (needed for the confirmation message text).
    const unlockResult = await this.handleContactUnlockPostPayment(request);

    // 1. Confirmation by email (the app already showed it on screen).
    await this.sendPaymentSuccessNotifications(request, context);

    // 2. Contact details (regular unlock) — this is what the user is waiting
    // for after paying, so send it before the invoice, not after.
    for (const id of unlockResult.unlockedAttemptIds) {
      await this.botNotification
        .sendContactUnlockedNotification(id)
        .catch((err) =>
          this.logger.warn(
            `Contact unlock notification failed for ${id}:`,
            err,
          ),
        );
    }

    // 3. Contact details (recommendation unlock)
    await this.handleRecommendationContactPostPayment(request, context);

    // 4. Invoice PDF (email only) — fire-and-forget. PDF generation + email are
    // relatively slow and the invoice isn't needed to complete the unlock, so
    // we don't await it: the user gets their contact immediately while the
    // invoice is produced in the background of this worker process.
    void this.createAndSendInvoice(request, context).catch((err) =>
      this.logger.error(
        `Invoice creation/sending failed for payment ${request.id}:`,
        err,
      ),
    );

    // 5. Parrainage payout — deliberately last, and deliberately not awaited.
    //
    // It credits two wallets, neither of which belongs to the person watching
    // this payment complete, and it is the only step here that costs nothing to
    // run late: settleForReferee re-derives its own facts from the database, so
    // the KYC approval path and the parrainage screen both replay it. Nothing
    // about a referral lookup belongs between a payer and the contact they just
    // bought.
    //
    // This method is also the boundary that keeps wallet-credit-paid unlocks
    // out of the program: those settle in ContactUnlockService.payUnlock and
    // RecommendationContactService and never reach here. Do NOT add a second
    // call site there — paying a parrainage on credit the platform issued is
    // how the program funds itself out of its own bonuses.
    //
    // Gated on `context`, not on `request.request_type`:
    // buildPaymentProcessingContext treats a request carrying a
    // contact_unlock_attempt_id as an unlock whatever its type says, and a
    // second copy of that rule here would drift from the one above it.
    if (context.isContactUnlock || context.isRecommendationContact) {
      void this.referralService
        .settleForReferee(request.profile_id)
        .catch((err) =>
          this.logger.error(
            `Referral settlement failed for payment ${request.id}:`,
            err,
          ),
        );
    }
  }

  private async buildPaymentProcessingContext(
    request: PaymentRequestWithProfile,
  ): Promise<PaymentProcessingContext> {
    const amount = Number(request.amount ?? 0);
    const transactionRef = generatePaymentReference();

    const requestType = request.request_type;
    const isContactUnlock =
      requestType === PaymentRequestType.CONTACT_UNLOCK ||
      request.contact_unlock_attempt_id != null;
    const isRecommendationContact =
      requestType === PaymentRequestType.RECOMMENDATION_CONTACT;
    const recommendationWorkerId = request.recommendation_worker_id ?? null;

    let paymentDescription = request.description ?? 'Paiement';
    if (isRecommendationContact && recommendationWorkerId) {
      const recWorker = await this.prisma.profile.findUnique({
        where: { id: recommendationWorkerId },
        select: { first_name: true, last_name: true },
      });
      if (recWorker) {
        paymentDescription =
          `Contact recommandé — ${recWorker.first_name} ${recWorker.last_name}`.trim();
      }
    }

    return {
      amount,
      transactionRef,
      isContactUnlock,
      isRecommendationContact,
      recommendationWorkerId,
      paymentType: resolvePaymentType(
        requestType,
        isContactUnlock,
        isRecommendationContact,
      ),
      paymentDescription,
    };
  }

  /**
   * Atomically claims the payment request by transitioning it from a
   * non-terminal status to APPROVED inside a single DB transaction.
   * Returns true if this call won the race (and wallet/payment records were
   * created), false if another thread already processed it.
   */
  private async persistApprovedPayment(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
    transactionId?: string,
  ): Promise<boolean> {
    const [systemWallet, mobileMoneyWallet] = await Promise.all([
      this.walletService.getOrCreateSystemWallet(),
      this.walletService.getOrCreateMobileMoneyWallet(),
    ]);

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentRequest.updateMany({
        where: {
          id: request.id,
          status: {
            notIn: [
              PaymentRequestStatus.APPROVED,
              PaymentRequestStatus.REJECTED,
            ],
          },
        },
        data: {
          status: PaymentRequestStatus.APPROVED,
          payment_reference: context.transactionRef,
          ...(transactionId && { gateway_tx_id: transactionId }),
        },
      });

      if (claimed.count === 0) {
        return false;
      }

      await tx.payment.create({
        data: {
          type: context.paymentType,
          profile_id: request.profile_id,
          amount: context.amount,
          payment_method: PaymentMethod.MOBILE_MONEY,
          transaction_id: context.transactionRef,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: context.paymentDescription,
        },
      });

      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type:
            context.isContactUnlock || context.isRecommendationContact
              ? WalletTransactionType.CONTACT_UNLOCK_PAYMENT
              : WalletTransactionType.CREDIT_PENALTY,
          amount: context.amount,
          reference_type: 'payment_request',
          reference_id: request.id,
        },
      });

      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: context.amount } },
      });

      // Credit MOBILE_MONEY wallet — encode gateway:operator in reference_type
      const mmReferenceType = [
        'payment_request',
        request.gateway ?? 'UNKNOWN_GATEWAY',
        request.operator ?? 'UNKNOWN_OPERATOR',
      ].join(':');

      await tx.walletTransaction.create({
        data: {
          wallet_id: mobileMoneyWallet.id,
          type: WalletTransactionType.MOBILE_MONEY_CREDIT,
          amount: context.amount,
          reference_type: mmReferenceType,
          reference_id: request.id,
        },
      });

      await tx.wallet.update({
        where: { id: mobileMoneyWallet.id },
        data: { balance: { increment: context.amount } },
      });

      return true;
    });
  }

  private async persistFailedPayment(
    request: PaymentRequestWithProfile,
    options: {
      reason:
        | 'GATEWAY_FAILED'
        | 'GATEWAY_CANCELLED'
        | 'POLL_TIMEOUT'
        | 'GATEWAY_INIT_ERROR';
      gatewayStatus?: string;
      transactionId?: string;
      gatewayRef?: string;
      errorMessage?: string;
      pollAttempt?: number;
    },
  ): Promise<void> {
    const transactionRef = generatePaymentReference();
    const profileName = this.fullName(request.profile);

    try {
      const isContactType =
        request.request_type === PaymentRequestType.CONTACT_UNLOCK ||
        request.request_type === PaymentRequestType.RECOMMENDATION_CONTACT ||
        request.contact_unlock_attempt_id != null;
      await this.prisma.payment.create({
        data: {
          type: resolvePaymentType(request.request_type, isContactType, false),
          profile_id: request.profile_id,
          amount: Number(request.amount ?? 0),
          payment_method: PaymentMethod.MOBILE_MONEY,
          transaction_id: transactionRef,
          status: PaymentStatus.FAILED,
          description: request.description ?? 'Paiement échoué',
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not create FAILED payment record for request ${request.id}`,
        err instanceof Error ? err.message : String(err),
      );
    }

    this.logService
      .create({
        action: 'PAYMENT_FAILED',
        entityType: 'payment_request',
        entityId: request.id,
        profileId: request.profile_id,
        metadata: {
          reason: options.reason,
          gatewayStatus: options.gatewayStatus ?? null,
          transactionId: options.transactionId ?? null,
          gatewayRef: options.gatewayRef ?? request.gateway_payment_ref ?? null,
          gateway: request.gateway ?? null,
          requestType: request.request_type ?? null,
          amount: Number(request.amount ?? 0),
          phone: request.phone ?? null,
          operator: request.operator ?? null,
          profileName,
          pollAttempt: options.pollAttempt ?? null,
          errorMessage: options.errorMessage ?? null,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not write PAYMENT_FAILED log for request ${request.id}`,
          err instanceof Error ? err.message : String(err),
        ),
      );

    this.logger.warn(
      `Payment FAILED — request ${request.id} | reason: ${options.reason} | profile: ${profileName} | amount: ${Number(request.amount ?? 0)} FCFA | phone: ${request.phone ?? 'n/a'} | gatewayRef: ${options.gatewayRef ?? request.gateway_payment_ref ?? 'n/a'}`,
    );
  }

  private emitAdminPaymentNotification(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): void {
    const profileName = this.fullName(request.profile);
    this.eventEmitter.emit(AdminNotificationEvent.PAYMENT_PENALTY, {
      event: AdminNotificationEvent.PAYMENT_PENALTY,
      title: 'Paiement reçu',
      message: `${profileName} a effectué un paiement de ${context.amount.toLocaleString('fr-FR')} FCFA — ${context.paymentDescription}`,
      entityType: 'profile',
      entityId: request.profile_id,
      timestamp: new Date().toISOString(),
    });
  }

  private async sendPaymentSuccessNotifications(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    const profileName = this.fullName(request.profile);

    // No WhatsApp "Paiement confirmé" here: every payment is confirmed on
    // screen (the payment page or the in-app result), and the message only
    // repeated it. What the payer actually needs on WhatsApp follows on its
    // own — the unlocked contact, and the receipt when they ask for it.
    if (request.profile.email) {
      await this.mailService
        .sendMail({
          to: request.profile.email,
          subject: `Paiement confirmé — ${context.paymentDescription}`,
          html: await this.layoutService.wrap(
            paymentSuccessEmail(
              profileName,
              context.paymentDescription,
              context.amount,
              audienceOf(request.profile),
            ),
            { product: productOf(audienceOf(request.profile)) },
          ),
        })
        .catch((err) =>
          this.logger.warn(
            `Email notification failed for ${request.profile.email}:`,
            err,
          ),
        );
    }
  }

  private async createAndSendInvoice(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    // 1. Create invoice record. Recommendation-contact payments don't go
    // through ContactUnlockAttempt (they're a direct unlock), so we surface
    // the *worker* as the other party instead — otherwise the receipt would
    // print "ENTITÉ : -" for the entire recommendation flow.
    const relatedEntity = request.contact_unlock_attempt_id
      ? {
          type: 'contact_unlock_attempt' as const,
          id: request.contact_unlock_attempt_id,
        }
      : request.recommendation_worker_id
        ? { type: 'worker' as const, id: request.recommendation_worker_id }
        : null;

    const invoice = await this.invoiceService.create({
      profileId: request.profile_id,
      paymentRequestId: request.id,
      amount: context.amount,
      reason:
        context.isContactUnlock || context.isRecommendationContact
          ? InvoiceReason.CONTACT_UNLOCK
          : request.request_type === PaymentRequestType.WALLET_TOP_UP
            ? InvoiceReason.WALLET_TOP_UP
            : InvoiceReason.PENALTY,
      relatedEntityType: relatedEntity?.type,
      relatedEntityId: relatedEntity?.id,
    });

    // 2. Generate PDF — but only if there is somewhere to send it. The invoice
    // record above is a financial record and is always written; rendering its
    // PDF is pure work for the email, and most profiles have no email address.
    // It stays available on demand in the app's invoice list either way.
    if (!request.profile.email) return;

    const { buffer, filename } = await this.invoiceService.downloadAsAdmin(
      invoice.id,
    );

    // 3. Send the invoice by email only. We intentionally do NOT send it over
    // WhatsApp: that path uploads the PDF to storage and then calls
    // sendMediaMessage (two slow network round-trips), and this whole method is
    // awaited before the contact-details notification — so sending the invoice
    // on WhatsApp made the user wait longer for the contact they just paid for.
    // The PDF stays available in the app (invoice list) and by email.
    if (request.profile.email) {
      await this.mailService
        .sendMail({
          to: request.profile.email,
          subject: `Votre facture — ${context.paymentDescription}`,
          html: await this.layoutService.wrap(
            invoiceEmail(
              request.profile.first_name,
              context.paymentDescription,
              context.amount,
              audienceOf(request.profile),
            ),
            { product: productOf(audienceOf(request.profile)) },
          ),
          attachments: [
            {
              filename,
              content: buffer,
              contentType: 'application/pdf',
            },
          ],
        })
        .catch((err) =>
          this.logger.warn(
            `Invoice email failed for ${request.profile.email}:`,
            err,
          ),
        );
    }
  }

  private async handleContactUnlockPostPayment(
    request: PaymentRequestWithProfile,
  ): Promise<{ nowUnlocked: boolean; unlockedAttemptIds: string[] }> {
    if (!request.contact_unlock_attempt_id)
      return { nowUnlocked: false, unlockedAttemptIds: [] };

    try {
      const result = await this.contactUnlockService.payUnlock(
        request.contact_unlock_attempt_id,
        request.profile_id,
        false,
      );
      // Same derivation the wallet-payment path uses. It was duplicated here,
      // and "which attempts did this actually unlock" is exactly the question
      // that, answered differently in two places, sends someone two contact
      // messages or none.
      const unlockedAttemptIds =
        this.contactUnlockService.unlockedAttemptIds(result);

      if (unlockedAttemptIds.length === 0) {
        return { nowUnlocked: false, unlockedAttemptIds: [] };
      }

      return { nowUnlocked: true, unlockedAttemptIds };
    } catch (err) {
      this.logger.error(
        `Contact unlock processing failed for attempt ${String(request.contact_unlock_attempt_id)}:`,
        err,
      );
      return { nowUnlocked: false, unlockedAttemptIds: [] };
    }
  }

  /**
   * The money moved but the contact may not be released. The payment and its
   * ContactRecord stay as they are, for reconciliation; this flags it for the
   * team to refund and tells the employer, instead of going quiet.
   */
  private async withholdRecommendationContact(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    this.logger.warn(
      `Recommendation contact withheld: request ${request.id}, worker ${context.recommendationWorkerId} or employer ${request.profile_id} no longer eligible`,
    );
    await this.logService
      .create({
        action: 'RECOMMENDATION_CONTACT_WITHHELD',
        entityType: 'payment_request',
        entityId: request.id,
        profileId: request.profile_id,
        metadata: {
          reason: 'NOT_ELIGIBLE_AT_DELIVERY',
          workerId: context.recommendationWorkerId ?? null,
          amount: context.amount,
          needsRefund: true,
        },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Could not log withheld contact for request ${request.id}`,
          err instanceof Error ? err.message : String(err),
        ),
      );
    if (request.profile.phone) {
      await this.botNotification
        .sendMessage(
          request.profile.phone,
          'Ce profil n’est plus disponible : son contact ne peut pas vous être transmis. Votre paiement est bien enregistré, l’équipe Rabotka revient vers vous pour le remboursement.',
        )
        .catch(() => undefined);
    }
  }

  private async handleRecommendationContactPostPayment(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    if (!context.recommendationWorkerId) return;

    // Recorded BEFORE the phone guard below. The employer has paid either way,
    // and whether we can reach them on WhatsApp says nothing about whether the
    // money moved — gating the ledger on a deliverable phone number would drop
    // exactly the payments hardest to reconcile later.
    await this.contactRecords.record({
      employerId: request.profile_id,
      workerId: context.recommendationWorkerId,
      origin: ContactRecordOrigin.DIRECT,
      amount: context.amount,
      unlockedAt: new Date(),
      paymentRequestId: request.id,
    });

    try {
      // Eligibility again, at delivery: a link can be paid long after it was
      // created, and the worker (or the employer) may have been suspended,
      // refused or archived since (pentest A2-F18, #874).
      const [worker, employerOk] = await Promise.all([
        this.prisma.profile.findFirst({
          where: { id: context.recommendationWorkerId, ...CONTACTABLE_WORKER },
          select: {
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
          },
        }),
        this.prisma.profile.count({
          where: {
            id: request.profile_id,
            status: AccountStatus.ACTIVE,
            deleted_at: null,
          },
        }),
      ]);
      if (!worker || employerOk === 0) {
        await this.withholdRecommendationContact(request, context);
        return;
      }

      const workerName =
        `${worker.first_name ?? ''} ${worker.last_name ?? ''}`.trim() ||
        'le travailleur';

      // Before the phone check: the bell does not need a WhatsApp number.
      notifyProfile(this.eventEmitter, {
        recipientId: request.profile_id,
        actorId: context.recommendationWorkerId,
        input: {
          type: 'CONTACT_UNLOCKED',
          recipientRole: 'EMPLOYER',
          applicationId: null,
          counterpartName: personName(
            worker.first_name,
            worker.last_name,
            'le travailleur',
          ),
          jobTitle: null,
        },
      });
      if (!request.profile.phone) return;

      await this.botNotification
        .sendContactUnlockedRecommendation({
          phone: request.profile.phone,
          employerId: request.profile_id,
          worker: {
            name: workerName,
            phone: worker.phone ?? null,
            email: worker.email ?? null,
          },
        })
        .catch((err) =>
          this.logger.warn(
            `Recommendation contact send failed for worker ${context.recommendationWorkerId}:`,
            err,
          ),
        );
    } catch (err) {
      this.logger.warn(
        `Failed to send recommendation contact for worker ${context.recommendationWorkerId}:`,
        err,
      );
    }
  }

  async submitPayment(token: string, dto: SubmitPaymentDto) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new BadRequestException("Cette demande n'est pas en attente");
    }

    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: PaymentRequestStatus.SUBMITTED,
        ...(dto.paymentReference && {
          payment_reference: dto.paymentReference,
        }),
        ...(dto.proofImages?.length && { proof_images: dto.proofImages }),
      },
    });

    return { message: 'Votre paiement est en cours de vérification.' };
  }

  async getList(dto: ListPaymentRequestsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const skip = (page - 1) * limit;
    // Active rows by default; the admin "Deleted" filter flips to archived rows.
    const where: Prisma.PaymentRequestWhereInput = {
      deleted_at: deletedAtFilter(dto.deleted),
      ...(dto.status ? { status: dto.status } : {}),
    };

    const [requests, total] = await Promise.all([
      this.prisma.paymentRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: PAYMENT_REQUEST_SELECT,
      }),
      this.prisma.paymentRequest.count({ where }),
    ]);

    return {
      data: requests.map((r) => this.formatRequest(r)),
      total,
      page,
      limit,
    };
  }

  /** Archive many payment requests at once (admin bulk delete). Returns the count archived. */
  async bulkSoftDelete(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const { count } = await this.prisma.paymentRequest.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    return { count };
  }

  private fullName(
    profile: Pick<
      PaymentRequestWithProfile['profile'],
      'first_name' | 'last_name'
    >,
  ) {
    return `${profile.first_name} ${profile.last_name}`;
  }

  private formatRequest(r: PaymentRequestWithProfile) {
    return {
      id: r.id,
      profileId: r.profile_id,
      profileName: this.fullName(r.profile),
      profileEmail: r.profile.email,
      profilePhone: r.profile.phone,
      profileStatus: r.profile.status,
      profileType: r.profile.profile_type,
      status: r.status,
      requestType: r.request_type ?? null,
      gateway: r.gateway ?? null,
      gatewayPaymentRef: r.gateway_payment_ref ?? null,
      amount: r.amount === null ? null : Number(r.amount),
      description: r.description,
      paymentReference: r.payment_reference,
      proofImages: r.proof_images,
      rejectionNote: r.rejection_note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async handleWalletTopUpPostPayment(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    if (request.request_type !== PaymentRequestType.WALLET_TOP_UP) return;

    try {
      await this.walletService.creditProfileWallet(
        request.profile_id,
        context.amount,
        WalletTransactionType.TOP_UP_CREDIT,
        'payment_request',
        request.id,
      );

      // Generate a downloadable invoice for the top-up (idempotent per
      // payment_request, so a retried post-payment won't duplicate it).
      await this.invoiceService
        .create({
          profileId: request.profile_id,
          paymentRequestId: request.id,
          amount: context.amount,
          reason: InvoiceReason.WALLET_TOP_UP,
          relatedEntityType: 'payment_request',
          relatedEntityId: request.id,
        })
        .catch((err) =>
          this.logger.warn(
            `Wallet top-up invoice creation failed for payment request ${request.id}:`,
            err,
          ),
        );

      // The top-up is confirmed in-app (PAYMENT_SUCCEEDED, above).
      this.logger.log(
        `Wallet top-up: ${context.amount} FCFA credited to profile ${request.profile_id} via payment request ${request.id}`,
      );
    } catch (err) {
      this.logger.warn(
        `Wallet top-up post-payment processing failed for profile ${request.profile_id}:`,
        err,
      );
    }
  }

  /**
   * The penalties a penalty request pays for — never « every unpaid penalty of
   * the profile at settlement time ».
   *
   * Pentest A2-F04 (#860): settlement used to clear every unpaid penalty of
   * the profile, so a link priced for one small penalty, paid later, also
   * cleared every penalty issued in between. A request now carries the ids it
   * was priced for. Requests created before that column have none: they are
   * bounded to penalties that already existed when the request was created.
   */
  private pricedPenalties(
    request: Pick<PaymentRequestWithProfile, 'profile_id' | 'penalty_ids'> & {
      created_at: Date;
    },
  ): Prisma.PenaltyWhereInput {
    const base: Prisma.PenaltyWhereInput = {
      profile_id: request.profile_id,
      paid_at: null,
      deleted_at: null,
    };
    return request.penalty_ids.length
      ? { ...base, id: { in: request.penalty_ids } }
      : { ...base, created_at: { lte: request.created_at } };
  }

  /**
   * Refuses to start a penalty payment whose priced set is no longer what is
   * owed — one of its penalties paid another way or archived since. Charging
   * the stored amount then would take money for nothing.
   */
  private async assertPenaltiesStillOwed(request: {
    request_type: PaymentRequestType | null;
    penalty_ids: string[];
    profile_id: string;
  }): Promise<void> {
    if (
      request.request_type !== PaymentRequestType.PENALTY_BATCH &&
      request.request_type !== PaymentRequestType.PENALTY_RESOLUTION
    )
      return;
    if (request.penalty_ids.length === 0) return;

    const stillOwed = await this.prisma.penalty.count({
      where: {
        id: { in: request.penalty_ids },
        profile_id: request.profile_id,
        paid_at: null,
        deleted_at: null,
      },
    });
    if (stillOwed !== request.penalty_ids.length) {
      throw new BadRequestException(
        'Vos pénalités ont changé depuis la création de ce paiement. Relancez le règlement depuis l’application.',
      );
    }
  }

  private async handlePenaltyPostPayment(
    request: PaymentRequestWithProfile,
  ): Promise<void> {
    if (
      request.request_type !== PaymentRequestType.PENALTY_BATCH &&
      request.request_type !== PaymentRequestType.PENALTY_RESOLUTION
    )
      return;

    const workerId = request.profile_id;

    try {
      const fees = await this.systemConfig.getFees();
      const now = new Date();

      const newStatus = await this.prisma.$transaction(async (tx) => {
        await tx.penalty.updateMany({
          where: this.pricedPenalties(request),
          data: { paid_at: now },
        });

        const unpaidCount = await tx.penalty.count({
          where: { profile_id: workerId, paid_at: null, deleted_at: null },
        });

        let status: BillingStatus;
        if (unpaidCount === 0) {
          status = BillingStatus.CLEAR;
        } else if (unpaidCount >= fees.billingBlockThreshold) {
          status = BillingStatus.BLOCKED;
        } else {
          status = BillingStatus.PENDING_PAYMENT;
        }

        await tx.profile.update({
          where: { id: workerId },
          data: { billing_status: status },
        });

        return status;
      });

      if (request.profile.phone) {
        await this.botNotification
          .sendMessage(
            request.profile.phone,
            formatPenaltyPaidSuccess(request.profile.first_name ?? ''),
          )
          .catch((err) =>
            this.logger.warn(
              `Penalty paid success notification failed for profile ${workerId}:`,
              err,
            ),
          );
      }

      this.logger.log(
        `Penalties marked paid for worker ${workerId} via payment request ${request.id}. New billing status: ${newStatus}`,
      );
    } catch (err) {
      this.logger.warn(
        `Penalty post-payment processing failed for profile ${workerId}:`,
        err,
      );
    }
  }
}
