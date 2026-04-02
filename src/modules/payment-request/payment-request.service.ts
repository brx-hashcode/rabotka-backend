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
} from '@prisma/client';
import { randomUUID } from 'crypto';
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
import { ContactUnlockService } from '../contact-unlock/contact-unlock.service';
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
      amount: request.amount !== null ? Number(request.amount) : null,
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
    operator: 'MTN' | 'AIRTEL',
  ): Promise<{ success: boolean }> {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
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

    const { serviceKey, serviceSecret, apiUrl } =
      await this.systemConfig.getMonetbilConfig();

    if (!serviceKey || !serviceSecret) {
      throw new BadRequestException(
        'Monetbil non configuré pour les paiements en ligne',
      );
    }

    const paymentRef = generatePaymentReference();
    const backendUrl = this.config.get<string>('BACKEND_URL', '');
    const notifyUrl = `${backendUrl}/api/v1/webhooks/monetbil/callback`;

    const result = await this.monetbilService.initiatePayment({
      serviceId: serviceKey,
      serviceSecret,
      amount: Number(request.amount),
      phone,
      operator,
      paymentRef,
      notifyUrl,
      apiUrl,
    });

    if (!result.success) {
      throw new BadRequestException(
        result.message || "Échec de l'initiation du paiement",
      );
    }

    await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: PaymentRequestStatus.PROCESSING,
        phone,
        operator,
        monetbil_payment_ref: paymentRef,
      },
    });

    return { success: true };
  }

  /**
   * Handles the Monetbil webhook callback.
   * On success: credits system wallet, sends notifications, pushes WebSocket update.
   * On failure: marks rejected, pushes WebSocket update.
   */
  async handleMonetbilCallback(
    payload: Record<string, string>,
  ): Promise<{ received: boolean }> {
    const { payment_ref, status, transaction_id } = payload;

    if (!payment_ref) {
      this.logger.warn('Monetbil callback missing payment_ref');
      return { received: true };
    }

    const request = await this.prisma.paymentRequest.findUnique({
      where: { monetbil_payment_ref: payment_ref },
      select: { ...PAYMENT_REQUEST_SELECT, monetbil_payment_ref: true },
    });

    if (!request) {
      this.logger.warn(
        `Monetbil callback: payment_ref not found: ${payment_ref}`,
      );
      return { received: true };
    }

    if (
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      // Already processed (duplicate callback)
      return { received: true };
    }

    // Verify HMAC signature
    const { serviceSecret } = await this.systemConfig.getMonetbilConfig();
    if (
      typeof serviceSecret === 'string' &&
      !this.monetbilService.verifyWebhookSignature(payload, serviceSecret)
    ) {
      this.logger.warn(
        `Monetbil callback: invalid signature for ref ${payment_ref}`,
      );
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

    // Push real-time status to the browser via WebSocket
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
    const amount = Number(request.amount ?? 0);
    const transactionRef = generatePaymentReference();

    const isContactUnlock = request.contact_unlock_attempt_id != null;

    // 1. Credit system wallet + create Payment record (atomic)
    const systemWallet = await this.walletService.getOrCreateSystemWallet();
    await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          type: isContactUnlock ? PaymentType.CONTACT_UNLOCK : PaymentType.PENALTY,
          profile_id: request.profile_id,
          amount,
          payment_method: PaymentMethod.MOBILE_MONEY,
          transaction_id: transactionRef,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: request.description ?? undefined,
        },
      }),
      this.prisma.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: isContactUnlock
            ? WalletTransactionType.CONTACT_UNLOCK_PAYMENT
            : WalletTransactionType.CREDIT_PENALTY,
          amount,
          reference_type: 'payment_request',
          reference_id: request.id,
        },
      }),
      this.prisma.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: amount } },
      }),
      this.prisma.paymentRequest.update({
        where: { id: request.id },
        data: {
          status: PaymentRequestStatus.APPROVED,
          payment_reference: transactionRef,
          ...(transactionId && { monetbil_tx_id: transactionId }),
        },
      }),
    ]);

    this.logger.log(
      `Payment approved: ${request.id} — ${amount} FCFA credited to system wallet`,
    );

    const profileName = this.fullName(request.profile);
    const description: string = request.description ?? 'Paiement';

    // 2. Emit admin notification
    this.eventEmitter.emit(AdminNotificationEvent.PAYMENT_PENALTY, {
      event: AdminNotificationEvent.PAYMENT_PENALTY,
      title: 'Paiement reçu',
      message: `${profileName} a effectué un paiement de ${amount.toLocaleString('fr-FR')} FCFA — ${description}`,
      entityType: 'profile',
      entityId: request.profile_id,
      timestamp: new Date().toISOString(),
    });

    // 3. Send WhatsApp notification
    if (request.profile.phone) {
      const text = [
        `✅ *Paiement confirmé*`,
        `Montant : *${amount.toLocaleString('fr-FR')} FCFA*`,
        `Objet : ${description}`,
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

    // 4. Send email notification
    if (request.profile.email) {
      await this.mailService
        .sendMail({
          to: request.profile.email,
          subject: `Paiement confirmé — ${description}`,
          html: paymentSuccessEmail(profileName, description, amount),
        })
        .catch((err) =>
          this.logger.warn(
            `Email notification failed for ${request.profile.email}:`,
            err,
          ),
        );
    }

    if (request.contact_unlock_attempt_id) {
      try {
        const result = await this.contactUnlockService.payUnlock(
          request.contact_unlock_attempt_id,
          request.profile_id,
          false,
        );
        if (result.status === 'UNLOCKED' || result.newlyUnlocked.length > 0) {
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
        }
      } catch (err) {
        this.logger.warn(
          `Contact unlock processing failed for attempt ${String(request.contact_unlock_attempt_id)}:`,
          err,
        );
      }
    }
  }

  /** Legacy manual proof submission — kept for backward compatibility */
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
      amount: r.amount !== null ? Number(r.amount) : null,
      description: r.description,
      paymentReference: r.payment_reference,
      proofImages: r.proof_images,
      rejectionNote: r.rejection_note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
