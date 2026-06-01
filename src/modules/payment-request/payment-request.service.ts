import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  PaymentRequestStatus,
  PaymentRequestType,
  Prisma,
  WalletTransactionType,
  PaymentType,
  PaymentMethod,
  PaymentStatus,
  InvoiceReason,
  BillingStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { paymentSuccessEmail } from '../mail/templates';
import { PaymentGatewayService } from '../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { formatPenaltyPaidSuccess } from '../bot/messages/penalty.messages';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import { InvoiceService } from '../invoice/invoice.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { LogService } from '../log/log.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';
import type { PollPaymentStatusJobData } from './poll-payment-status.processor';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';
import { SubmitPaymentDto } from './dto/submit-payment.dto';

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
  monetbil_payment_ref: true,
  request_type: true,
  recommendation_worker_id: true,
  contact_unlock_attempt_id: true,
  profile: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      status: true,
      profile_type: true,
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
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentStatusGateway: PaymentStatusGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly botNotification: BotNotificationService,
    private readonly contactUnlockService: ContactUnlockService,
    private readonly invoiceService: InvoiceService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly logService: LogService,
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

    const activeGateway = await this.systemConfig
      .getPaymentGatewayDriver()
      .catch(() => 'MONETBIL');

    return {
      id: request.id,
      status: request.status,
      gateway: activeGateway,
      profileName: this.fullName(request.profile),
      amount: request.amount === null ? null : Number(request.amount),
      description: request.description ?? null,
    };
  }

  /**
   * Initiates a Monetbil USSD push for the given token.
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
        profile: { select: { first_name: true, last_name: true, email: true } },
      },
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (!request.amount) {
      throw new BadRequestException('Montant non défini pour cette demande');
    }

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
    const profileEmail = request.profile?.email ?? '';

    let gatewayRef: string;
    try {
      const result = await this.paymentGateway.initiatePayment({
        amount: Number(request.amount),
        currency: 'XAF',
        externalId: request.id,
        phone,
        description: request.description ?? undefined,
        metadata: { operator, userName: profileName, email: profileEmail },
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

    const activeGateway = await this.systemConfig
      .getPaymentGatewayDriver()
      .catch(() => 'MONETBIL');

    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        gateway: activeGateway,
        gateway_payment_ref: gatewayRef || null,
        monetbil_payment_ref: gatewayRef || null, // keep for backward compat during transition
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
    const { gatewayRef, status, transactionId } =
      await this.paymentGateway.handleWebhookPayload(payload);

    if (!gatewayRef) {
      this.logger.warn('Payment callback missing gatewayRef');
      return { received: true };
    }

    const request = await this.prisma.paymentRequest.findFirst({
      where: {
        OR: [
          { gateway_payment_ref: gatewayRef },
          { monetbil_payment_ref: gatewayRef },
        ],
      },
      select: {
        ...PAYMENT_REQUEST_SELECT,
        gateway_payment_ref: true,
        monetbil_payment_ref: true,
      },
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
      this.notifyPaymentFailedByWebhook(request).catch((err: unknown) =>
        this.logger.warn(
          `Could not send webhook failure WhatsApp notification for request ${request.id}`,
          err instanceof Error ? err.message : String(err),
        ),
      );
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
  ): Promise<void> {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: requestId },
      select: {
        ...PAYMENT_REQUEST_SELECT,
        gateway_payment_ref: true,
        monetbil_payment_ref: true,
      },
    });
    if (
      !request ||
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      return;
    }
    await this.processSuccessfulPayment(request, transactionId);
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

    this.emitAdminPaymentNotification(request, context);
    await this.handlePenaltyPostPayment(request);

    // Compute unlock result first (needed for the confirmation message text)
    // but defer sending the contact details notification until after invoice
    const unlockResult = await this.handleContactUnlockPostPayment(request);

    // 1. "🎉 Paiement confirmé"
    await this.sendPaymentSuccessNotifications(request, context, unlockResult);

    // 2. Invoice PDF
    await this.createAndSendInvoice(request, context).catch((err) =>
      this.logger.error(
        `Invoice creation/sending failed for payment ${request.id}:`,
        err,
      ),
    );

    // 3. Contact details (regular unlock)
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

    // 4. Contact details (recommendation unlock)
    await this.handleRecommendationContactPostPayment(request, context);
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
      paymentType:
        isContactUnlock || isRecommendationContact
          ? PaymentType.CONTACT_UNLOCK
          : PaymentType.PENALTY,
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

  private async notifyPaymentFailedByWebhook(
    request: { profile_id: string; amount: unknown },
  ): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: request.profile_id },
      select: { phone: true },
    });
    if (!profile?.phone) return;
    const amountStr = Number(request.amount).toLocaleString('fr-FR');
    const message = [
      `❌ *Paiement échoué*`,
      ``,
      `Votre paiement de *${amountStr} FCFA* via Mobile Money n'a pas abouti.`,
      ``,
      `Vous pouvez réessayer en tapant la commande correspondante, ou choisir un autre mode de paiement.`,
    ].join('\n');
    await this.whatsAppService.sendTextMessage(profile.phone, message);
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
          type: isContactType
            ? PaymentType.CONTACT_UNLOCK
            : PaymentType.PENALTY,
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
    unlockResult?: { nowUnlocked: boolean },
  ): Promise<void> {
    const profileName = this.fullName(request.profile);

    if (request.profile.phone) {
      const lines = [
        `🎉 *Paiement confirmé*`,
        '',
        `Montant : *${context.amount.toLocaleString('fr-FR')} FCFA*`,
        `Objet : ${context.paymentDescription}`,
        '',
        `Merci pour votre paiement !`,
      ];

      if (context.isRecommendationContact) {
        lines.push(
          '',
          '📞 *Les coordonnées du travailleur vous seront envoyées dans le message suivant.*',
        );
      } else if (context.isContactUnlock) {
        if (unlockResult?.nowUnlocked) {
          lines.push(
            '',
            '✅ *Les deux parties ont payé — les coordonnées vous ont été envoyées.*',
          );
        } else {
          lines.push(
            '',
            "⏳ *En attente du paiement de l'autre partie. Les coordonnées seront révélées dès que les deux parties auront payé.*",
          );
        }
      }

      const text = lines.join('\n');
      await this.whatsAppService
        .sendTextMessage(request.profile.phone, text)
        .catch((err) =>
          this.logger.warn(
            `WhatsApp notification failed for ${request.profile.phone}:`,
            err,
          ),
        );
    }

    if (request.profile.email) {
      await this.mailService
        .sendMail({
          to: request.profile.email,
          subject: `Paiement confirmé — ${context.paymentDescription}`,
          html: paymentSuccessEmail(
            profileName,
            context.paymentDescription,
            context.amount,
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
          : InvoiceReason.PENALTY,
      relatedEntityType: relatedEntity?.type,
      relatedEntityId: relatedEntity?.id,
    });

    // 2. Generate PDF
    const { buffer, filename } = await this.invoiceService.downloadAsAdmin(
      invoice.id,
    );

    // 3. Send email with PDF attachment
    if (request.profile.email) {
      await this.mailService
        .sendMail({
          to: request.profile.email,
          subject: `Votre facture — ${context.paymentDescription}`,
          html: `<p>Bonjour,</p><p>Veuillez trouver ci-joint votre facture pour le paiement de <strong>${context.amount.toLocaleString('fr-FR')} FCFA</strong>.</p>`,
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

    // 4. Send WhatsApp media (upload to storage to get a public URL)
    if (request.profile.phone) {
      const uploaded = await this.storageService
        .upload(buffer, filename, { folder: 'invoices' })
        .catch((err) => {
          this.logger.warn(`Invoice storage upload failed:`, err);
          return null;
        });

      if (uploaded?.url) {
        await this.whatsAppService
          .sendMediaMessage(
            request.profile.phone,
            uploaded.url,
            `📄 Votre facture de ${context.amount.toLocaleString('fr-FR')} FCFA`,
          )
          .catch((err) =>
            this.logger.warn(
              `Invoice WhatsApp send failed for ${request.profile.phone}:`,
              err,
            ),
          );
      }
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
      const nowUnlocked =
        result.status === 'UNLOCKED' || result.newlyUnlocked.length > 0;

      if (!nowUnlocked) return { nowUnlocked: false, unlockedAttemptIds: [] };

      const attemptIds =
        result.status === 'UNLOCKED'
          ? [result.attemptId, ...result.newlyUnlocked]
          : result.newlyUnlocked;

      return { nowUnlocked: true, unlockedAttemptIds: [...new Set(attemptIds)] };
    } catch (err) {
      this.logger.error(
        `Contact unlock processing failed for attempt ${String(request.contact_unlock_attempt_id)}:`,
        err,
      );
      return { nowUnlocked: false, unlockedAttemptIds: [] };
    }
  }

  private async handleRecommendationContactPostPayment(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
  ): Promise<void> {
    if (!context.recommendationWorkerId || !request.profile.phone) return;

    try {
      const worker = await this.prisma.profile.findUnique({
        where: { id: context.recommendationWorkerId },
        select: {
          first_name: true,
          last_name: true,
          phone: true,
          email: true,
        },
      });
      if (!worker) return;

      const waDigits = worker.phone ? worker.phone.replace(/\D/g, '') : null;
      const contactLines = [
        '🔓 *Contact déverrouillé avec succès !*',
        '',
        '👤 *Informations du travailleur*',
        `• *Prénom* : ${worker.first_name ?? '—'}`,
        `• *Nom* : ${worker.last_name ?? '—'}`,
        ...(worker.phone ? [`• *Téléphone* : ${worker.phone}`] : []),
        ...(waDigits ? [`• *WhatsApp* : https://wa.me/${waDigits}`] : []),
        ...(worker.email ? [`• *Email* : ${worker.email}`] : []),
        '',
        'Tapez *Menu* pour retourner au menu principal.',
      ].join('\n');
      await this.botNotification
        .sendMessage(request.profile.phone, contactLines)
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
    const where = dto.status ? { status: dto.status } : {};

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
          where: { profile_id: workerId, paid_at: null },
          data: { paid_at: now },
        });

        const unpaidCount = await tx.penalty.count({
          where: { profile_id: workerId, paid_at: null },
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
