import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  InvoiceReason,
  PaymentMethod,
  PaymentRequestType,
  PaymentStatus,
  PaymentType,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { InvoiceService } from '../invoice/invoice.service';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { PaymentRequestService } from '../payment-request/payment-request.service';
import { formatContactUnlockedMessage } from '../bot/messages/contact-unlock.messages';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppFeedbackService } from '../whatsapp/feedback/whatsapp-feedback.service';
import { generatePaymentReference } from '../../common/utils/payment-reference';
import { InteractionEventService } from '../recommendation-engine/interaction-event.service';
import { assertAccountActive } from '../../common/exceptions/account-not-active.exception';

/**
 * EMPLOYER pays to unlock a RECOMMENDED worker's contact. Stateless / single-sided
 * (no ContactUnlockAttempt): the employer pays the recommendation fee and the
 * worker's contact is delivered over WhatsApp. Mirrors the bot's
 * recommended-profiles wallet + mobile-money paths.
 */
@Injectable()
export class RecommendationContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly systemConfig: SystemConfigService,
    private readonly invoice: InvoiceService,
    private readonly botNotification: BotNotificationService,
    private readonly paymentRequest: PaymentRequestService,
    private readonly interactionEvents: InteractionEventService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    @Inject(forwardRef(() => WhatsAppFeedbackService))
    private readonly feedback: WhatsAppFeedbackService,
  ) {}

  async payWithWallet(
    employerId: string,
    workerId: string,
  ): Promise<{ ok: true }> {
    await this.assertEmployerActive(employerId);
    const worker = await this.getActiveWorker(workerId);
    const fee = await this.systemConfig.getRecommendationContactFee();
    const workerName = `${worker.first_name} ${worker.last_name}`.trim();

    const profileWallet = await this.wallet.getOrCreateProfileWallet(employerId);
    if (Number(profileWallet.balance) < fee) {
      throw new BadRequestException(
        'Solde insuffisant dans votre portefeuille',
      );
    }
    const systemWallet = await this.wallet.getOrCreateSystemWallet();
    const txRef = generatePaymentReference();

    let paymentId: string | undefined;
    await this.prisma.$transaction(async (tx) => {
      await tx.walletTransaction.create({
        data: {
          wallet_id: profileWallet.id,
          type: WalletTransactionType.CONTACT_UNLOCK_DEBIT,
          amount: fee,
          reference_type: 'recommendation_contact',
          reference_id: workerId,
        },
      });
      await tx.wallet.update({
        where: { id: profileWallet.id },
        data: { balance: { decrement: fee } },
      });
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
          amount: fee,
          reference_type: 'recommendation_contact',
          reference_id: workerId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: fee } },
      });
      const payment = await tx.payment.create({
        data: {
          type: PaymentType.CONTACT_UNLOCK,
          profile_id: employerId,
          amount: fee,
          payment_method: PaymentMethod.WALLET,
          transaction_id: txRef,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Contact recommandé — ${workerName} [worker:${workerId}]`,
        },
      });
      paymentId = payment.id;
    });

    if (paymentId) {
      void this.invoice
        .create({
          profileId: employerId,
          paymentId,
          amount: fee,
          reason: InvoiceReason.CONTACT_UNLOCK,
          relatedEntityType: 'worker',
          relatedEntityId: workerId,
        })
        .catch(() => undefined);
    }

    // Deliver the worker's contact to the employer over WhatsApp.
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { phone: true },
    });
    if (employer?.phone) {
      // Sent as an approved template, not free-form. The employer usually pays
      // on the web without ever messaging the bot, which puts them outside
      // WhatsApp's 24h service window — free-form is rejected there (63016), so
      // the contact they just paid for silently never arrived.
      const tpl = WHATSAPP_TEMPLATES.contactUnlockedRecommendation;
      void this.whatsApp
        .sendTemplateMessage(
          employer.phone,
          'contactUnlockedRecommendation',
          {
            name: workerName,
            phone: worker.phone ?? null,
            email: worker.email ?? null,
            flowToken: this.feedback.mintFlowToken(employerId),
          },
          employerId,
          formatContactUnlockedMessage({
            name: workerName,
            phone: worker.phone ?? null,
            email: worker.email ?? null,
          }),
        )
        .catch(() => undefined);
    }

    // Paying real money to reach a worker is the strongest preference signal an
    // employer can give. This path is otherwise stateless — no
    // ContactUnlockAttempt row — so without this the intent lives only in a
    // wallet transaction's reference_id.
    void this.interactionEvents.record({
      actorId: employerId,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.CONTACT_PAID,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: workerId,
      source: InteractionSource.SERVER,
      surface: 'recommendation_contact',
      metadata: { fee },
    });

    return { ok: true };
  }

  async createMobilePaymentUrl(
    employerId: string,
    workerId: string,
  ): Promise<{ token: string }> {
    await this.assertEmployerActive(employerId);
    const worker = await this.getActiveWorker(workerId);
    const fee = await this.systemConfig.getRecommendationContactFee();
    const workerName = `${worker.first_name} ${worker.last_name}`.trim();

    const url = await this.paymentRequest.createPaymentUrl(
      employerId,
      fee,
      `Contact recommandé — ${workerName}`,
      PaymentRequestType.RECOMMENDATION_CONTACT,
      { recommendationWorkerId: workerId },
    );
    const token = url.split('/pay/')[1] ?? '';
    return { token };
  }

  /**
   * The PAYING side must be in good standing too.
   *
   * `getActiveWorker` below has always checked the worker being unlocked; the
   * employer doing the unlocking was never checked at all, so a suspended
   * employer could keep spending wallet credit for as long as their session
   * lasted. `ActiveProfileGuard` now covers the HTTP route, and this repeats it
   * here for the same reason `job-offer.service` and `application.service`
   * repeat their KYC check: the guard and the service must not be able to
   * disagree, and a mobile-money payment can settle long after the request that
   * started it.
   */
  private async assertEmployerActive(employerId: string) {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { status: true, suspension_reason: true },
    });
    if (!employer) {
      throw new NotFoundException('Employeur introuvable');
    }
    assertAccountActive(employer.status, employer.suspension_reason);
  }

  private async getActiveWorker(workerId: string) {
    const worker = await this.prisma.profile.findFirst({
      where: {
        id: workerId,
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
      },
      select: {
        first_name: true,
        last_name: true,
        phone: true,
        email: true,
      },
    });
    if (!worker) {
      throw new NotFoundException(
        "Ce profil n'est plus actif ou vérifié.",
      );
    }
    return worker;
  }
}
