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
import { MonetbilService } from './monetbil.service';
import { PaymentStatusGateway } from '../ws-notifications/payment-status.gateway';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { formatPenaltyPaidSuccess } from '../bot/messages/penalty.messages';
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
import { InvoiceService } from '../invoice/invoice.service';
import { StorageService } from '../../common/services/storage/storage.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
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
  monetbil_payment_ref: true,
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
    private readonly monetbilService: MonetbilService,
    private readonly paymentStatusGateway: PaymentStatusGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly botNotification: BotNotificationService,
    private readonly contactUnlockService: ContactUnlockService,
    private readonly invoiceService: InvoiceService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Creates a payment request token for the given profile and returns
   * the public payment URL. Now requires amount + description.
   */
  async createPaymentUrl(
    profileId: string,
    amount: number,
    description: string,
    contactUnlockAttemptId?: string,
  ): Promise<string> {
    const token = randomUUID();
    await this.prisma.paymentRequest.create({
      data: {
        profile_id: profileId,
        token,
        amount,
        description,
        ...(contactUnlockAttemptId && {
          contact_unlock_attempt_id: contactUnlockAttemptId,
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

    return {
      id: request.id,
      status: request.status,
      profileName: this.fullName(request.profile),
      amount: request.amount === null ? null : Number(request.amount),
      description: request.description ?? null,
    };
  }

  /**
   * Initiates a Monetbil USSD push for the given token.
   * Updates the PaymentRequest to PROCESSING status.
   */
  async initiateMonetbilPayment(
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

    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new BadRequestException(
        "Cette demande n'est pas en attente de paiement",
      );
    }

    if (!request.amount) {
      throw new BadRequestException('Montant non défini pour cette demande');
    }

    const { serviceKey } = await this.systemConfig.getMonetbilConfig();

    if (!serviceKey) {
      throw new BadRequestException(
        'Monetbil non configuré pour les paiements en ligne',
      );
    }

    const profileName = request.profile
      ? `${request.profile.first_name} ${request.profile.last_name}`.trim()
      : 'Utilisateur';
    const profileEmail = request.profile?.email ?? '';

    const result = await this.monetbilService.initiatePayment({
      serviceKey,
      amount: Number(request.amount),
      phonenumber: phone,
      operator,
      user: profileName,
      email: profileEmail,
    });

    if (!result.success) {
      throw new BadRequestException(
        result.message || "Échec de l'initiation du paiement",
      );
    }

    const paymentId =
      typeof result.paymentId === 'string' ? String(result.paymentId) : '';

    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: PaymentRequestStatus.PROCESSING,
        phone,
        operator,
        monetbil_payment_ref: paymentId || null,
      },
    });

    // Fire-and-forget polling loop — checks status every 5s, up to 10 attempts.
    // On conclusive result: processes payment + emits WebSocket update to client.
    if (paymentId) {
      this.pollPaymentStatus(request.id, request.token, paymentId).catch(
        (err: unknown) =>
          this.logger.error(
            `Polling failed for request ${request.id}`,
            err instanceof Error ? err.stack : String(err),
          ),
      );
    }

    return { success: true };
  }

  private async pollPaymentStatus(
    requestId: string,
    token: string,
    paymentId: string,
    maxAttempts = 10,
    intervalMs = 5000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.logger.log(
        `Monetbil poll attempt ${attempt}/${maxAttempts} for paymentId ${paymentId}`,
      );

      const { status, transactionId } =
        await this.monetbilService.checkPayment(paymentId);
      const safeTransactionId =
        typeof transactionId === 'string' ? transactionId : undefined;

      if (status === 'SUCCESS') {
        const request = await this.prisma.paymentRequest.findUnique({
          where: { id: requestId },
          select: {
            ...PAYMENT_REQUEST_SELECT,
            monetbil_payment_ref: true,
          },
        });
        if (
          request &&
          request.status !== PaymentRequestStatus.APPROVED &&
          request.status !== PaymentRequestStatus.REJECTED
        ) {
          await this.processSuccessfulPayment(request, safeTransactionId);
        }
        this.paymentStatusGateway.emitPaymentStatus(token, 'APPROVED');
        return;
      }

      if (status === 'FAILED' || status === 'CANCELLED') {
        await this.prisma.paymentRequest.update({
          where: { id: requestId },
          data: {
            status: PaymentRequestStatus.REJECTED,
            ...(safeTransactionId && { monetbil_tx_id: safeTransactionId }),
          },
        });
        this.paymentStatusGateway.emitPaymentStatus(token, 'REJECTED');
        return;
      }

      // PENDING — wait before next attempt (skip wait on last attempt)
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    // All attempts exhausted with no conclusive result.
    // Revert to PENDING so the Monetbil webhook can still finalize the payment
    // if the mobile money transaction completes asynchronously.
    this.logger.warn(
      `Monetbil polling timed out for paymentId ${paymentId} after ${maxAttempts} attempts — reverting to PENDING`,
    );
    await this.prisma.paymentRequest.update({
      where: { id: requestId },
      data: { status: PaymentRequestStatus.PENDING },
    });
    this.paymentStatusGateway.emitPaymentStatus(token, 'TIMEOUT');
  }

  /**
   * Handles the Monetbil webhook callback.
   * On success: credits system wallet, sends notifications, pushes WebSocket update.
   * On failure: marks rejected, pushes WebSocket update.
   */
  async handleMonetbilCallback(
    payload: Record<string, string>,
  ): Promise<{ received: boolean }> {
    const paymentId = payload['paymentId'] ?? payload['payment_ref'];
    const status = payload['status'];
    const transaction_id = payload['transaction_id'];

    if (!paymentId) {
      this.logger.warn('Monetbil callback missing paymentId');
      return { received: true };
    }

    const request = await this.prisma.paymentRequest.findUnique({
      where: { monetbil_payment_ref: paymentId },
      select: { ...PAYMENT_REQUEST_SELECT, monetbil_payment_ref: true },
    });

    if (!request) {
      this.logger.warn(`Monetbil callback: paymentId not found: ${paymentId}`);
      return { received: true };
    }

    if (
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      return { received: true };
    }

    const isSuccess = status === '1';

    if (isSuccess) {
      await this.processSuccessfulPayment(request, transaction_id);
    } else {
      await this.prisma.paymentRequest.update({
        where: { id: request.id },
        data: {
          status: PaymentRequestStatus.REJECTED,
          ...(transaction_id && { monetbil_tx_id: transaction_id }),
        },
      });
      this.logger.log(`Payment rejected for request ${request.id}`);
    }

    this.paymentStatusGateway.emitPaymentStatus(
      request.token,
      isSuccess ? 'APPROVED' : 'REJECTED',
    );

    return { received: true };
  }

  private async processSuccessfulPayment(
    request: PaymentRequestWithProfile,
    transactionId?: string,
  ): Promise<void> {
    const context = await this.buildPaymentProcessingContext(request);
    await this.persistApprovedPayment(request, context, transactionId);

    this.logger.log(
      `Payment approved: ${request.id} — ${context.amount} FCFA credited to system wallet`,
    );

    this.emitAdminPaymentNotification(request, context);
    await this.sendPaymentSuccessNotifications(request, context);
    try {
      await this.createAndSendInvoice(request, context);
    } catch (err) {
      this.logger.error(
        `Invoice creation/sending failed for payment ${request.id}:`,
        err,
      );
      throw err;
    }
    await this.handleContactUnlockPostPayment(request);
    await this.handleRecommendationContactPostPayment(request, context);
    await this.handlePenaltyPostPayment(request);
  }

  private async buildPaymentProcessingContext(
    request: PaymentRequestWithProfile,
  ): Promise<PaymentProcessingContext> {
    const amount = Number(request.amount ?? 0);
    const transactionRef = generatePaymentReference();
    const isContactUnlock = request.contact_unlock_attempt_id != null;
    const recommendationWorkerIdMatch = request.description?.match(
      /^RECOMMENDATION_CONTACT:(.+)$/,
    );
    const recommendationWorkerId = recommendationWorkerIdMatch?.[1] ?? null;
    const isRecommendationContact = recommendationWorkerId != null;

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

  private async persistApprovedPayment(
    request: PaymentRequestWithProfile,
    context: PaymentProcessingContext,
    transactionId?: string,
  ): Promise<void> {
    const systemWallet = await this.walletService.getOrCreateSystemWallet();
    await this.prisma.$transaction([
      this.prisma.payment.create({
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
      }),
      this.prisma.walletTransaction.create({
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
      }),
      this.prisma.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: context.amount } },
      }),
      this.prisma.paymentRequest.update({
        where: { id: request.id },
        data: {
          status: PaymentRequestStatus.APPROVED,
          payment_reference: context.transactionRef,
          ...(transactionId && { monetbil_tx_id: transactionId }),
        },
      }),
    ]);
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

    if (request.profile.phone) {
      const text = [
        `🎉 *Paiement confirmé*`,
        '',
        `Montant : *${context.amount.toLocaleString('fr-FR')} FCFA*`,
        `Objet : ${context.paymentDescription}`,
        '',
        `Merci pour votre paiement !`,
      ].join('\n');
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
    // 1. Create invoice record
    const invoice = await this.invoiceService.create({
      profileId: request.profile_id,
      paymentRequestId: request.id,
      amount: context.amount,
      reason:
        context.isContactUnlock || context.isRecommendationContact
          ? InvoiceReason.CONTACT_UNLOCK
          : InvoiceReason.PENALTY,
      relatedEntityType: request.contact_unlock_attempt_id
        ? 'contact_unlock_attempt'
        : undefined,
      relatedEntityId: request.contact_unlock_attempt_id ?? undefined,
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
  ): Promise<void> {
    if (!request.contact_unlock_attempt_id) return;

    try {
      const result = await this.contactUnlockService.payUnlock(
        request.contact_unlock_attempt_id,
        request.profile_id,
        false,
      );
      if (result.status !== 'UNLOCKED' && result.newlyUnlocked.length === 0) {
        return;
      }

      const attemptIds =
        result.status === 'UNLOCKED'
          ? [result.attemptId, ...result.newlyUnlocked]
          : result.newlyUnlocked;
      for (const id of new Set(attemptIds)) {
        await this.botNotification
          .sendContactUnlockedNotification(id)
          .catch((err) =>
            this.logger.warn(
              `Contact unlock notification failed for ${id}:`,
              err,
            ),
          );
      }
    } catch (err) {
      this.logger.warn(
        `Contact unlock processing failed for attempt ${String(request.contact_unlock_attempt_id)}:`,
        err,
      );
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

      const contactLines = [
        '🔓 *Contact déverrouillé avec succès !*',
        '',
        '👤 *Informations du travailleur*',
        `• *Prénom* : ${worker.first_name ?? '—'}`,
        `• *Nom* : ${worker.last_name ?? '—'}`,
        ...(worker.phone ? [`• *Téléphone* : ${worker.phone}`] : []),
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
    if (!request.description?.startsWith('PENALTY_BATCH:')) return;

    const workerId = request.profile_id;

    try {
      const fees = await this.systemConfig.getFees();
      const now = new Date();

      const newStatus = await this.prisma.$transaction(async (tx) => {
        await tx.penalty.updateMany({
          where: { worker_id: workerId, paid_at: null },
          data: { paid_at: now },
        });

        const unpaidCount = await tx.penalty.count({
          where: { worker_id: workerId, paid_at: null },
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
