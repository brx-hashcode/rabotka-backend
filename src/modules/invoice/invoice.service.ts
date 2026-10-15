import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  BadGatewayException,
  ServiceUnavailableException,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import { WhatsAppDocumentService } from '../whatsapp/documents/whatsapp-document.service';
import Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { DocumentService } from '../document/document.service';
import {
  DocumentCategory,
  InvoiceReason,
  PaymentMethod,
  ProfileType,
} from '@prisma/client';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';

const PROFILE_TYPE_LABELS: Record<ProfileType, string> = {
  [ProfileType.WORKER]: 'Travailleur',
  [ProfileType.EMPLOYER]: 'Employeur',
};

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.MOBILE_MONEY]: 'Mobile Money',
  [PaymentMethod.CARD]: 'Carte bancaire',
  [PaymentMethod.WALLET]: 'Crédit portefeuille',
  [PaymentMethod.OTHER]: 'Autre',
};

export type InvoiceItem = {
  id: string;
  profileId: string;
  paymentRequestId: string | null;
  amount: string;
  reason: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  status: string;
  createdAt: string;
};

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly documentService: DocumentService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    // Appended and @Optional(): specs build this service by position.
    @Optional() private readonly whatsAppDocuments?: WhatsAppDocumentService,
  ) {}

  /**
   * Sends the invoice PDF to the owner's own WhatsApp, on request (the
   * "Envoyer le reçu" button after a payment). Never sent unasked: the payer
   * has just seen the confirmation in the app.
   *
   * Only to the number on the profile — never to a number from the request —
   * so the route cannot be used to deliver someone's invoice elsewhere.
   */
  async sendToWhatsApp(
    invoiceId: string,
    requestingProfileId: string,
  ): Promise<{ sent: true }> {
    // Ownership is checked here (403 for someone else's invoice), and the PDF
    // comes from the same cache the download uses.
    const { buffer, filename } = await this.download(
      invoiceId,
      requestingProfileId,
    );

    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        amount: true,
        reason: true,
        profile: { select: { phone: true } },
        payment_request: { select: { description: true } },
      },
    });
    const phone = invoice?.profile.phone;
    if (!invoice || !phone) {
      throw new BadRequestException('Aucun numéro WhatsApp sur votre profil.');
    }

    const purpose =
      invoice.payment_request?.description ??
      {
        CONTACT_UNLOCK: 'Déverrouillage de contact',
        PENALTY: 'Régularisation',
        WALLET_TOP_UP: 'Recharge de portefeuille',
        OTHER: 'Paiement Rabotka',
      }[invoice.reason];

    let sent: boolean;
    try {
      sent =
        (await this.whatsAppDocuments?.sendPreferringWindow({
          phone,
          profileId: requestingProfileId,
          template: 'paymentReceiptDocument',
          params: {
            amount: Number(invoice.amount).toLocaleString('fr-FR'),
            purpose,
          },
          pdf: buffer,
          filename,
          // One object per invoice: a resend overwrites it.
          storageKey: `invoices/${invoiceId}.pdf`,
          // Used when the 24h window is open (plain document, no template).
          caption: `Votre reçu pour le paiement de ${Number(invoice.amount).toLocaleString('fr-FR')} FCFA — ${purpose}.`,
        })) ?? false;
    } catch (err) {
      this.logger.warn(
        `Invoice ${invoiceId} WhatsApp send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadGatewayException(
        "L'envoi du reçu sur WhatsApp a échoué. Réessayez dans un instant.",
      );
    }

    if (!sent) {
      // Window closed and the receipt template unavailable (document delivery
      // switched off, or a provider that cannot attach documents).
      throw new ServiceUnavailableException(
        "L'envoi du reçu sur WhatsApp n'est pas encore disponible.",
      );
    }
    return { sent: true };
  }

  private invoiceRef(id: string, createdAt: Date): string {
    const year = createdAt.getFullYear();
    const short = id.replaceAll('-', '').slice(0, 8).toUpperCase();
    return `RBT-${year}-${short}`;
  }

  async create(params: {
    profileId: string;
    paymentRequestId?: string;
    paymentId?: string;
    amount: number;
    reason: InvoiceReason;
    relatedEntityType?: string;
    relatedEntityId?: string;
  }): Promise<InvoiceItem> {
    if (params.amount <= 0) {
      throw new BadRequestException('Invoice amount must be positive');
    }
    if (params.paymentRequestId) {
      const existing = await this.prisma.invoice.findUnique({
        where: { payment_request_id: params.paymentRequestId },
      });
      if (existing) return this.mapInvoice(existing);
    } else if (params.paymentId) {
      const existing = await this.prisma.invoice.findUnique({
        where: { payment_id: params.paymentId },
      });
      if (existing) return this.mapInvoice(existing);
    }

    const invoice = await this.prisma.invoice.create({
      data: {
        profile_id: params.profileId,
        payment_request_id: params.paymentRequestId ?? null,
        payment_id: params.paymentId ?? null,
        amount: params.amount,
        reason: params.reason,
        related_entity_type: params.relatedEntityType ?? null,
        related_entity_id: params.relatedEntityId ?? null,
      },
    });
    return this.mapInvoice(invoice);
  }

  async listForProfile(profileId: string): Promise<InvoiceItem[]> {
    const invoices = await this.prisma.invoice.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
    });
    return invoices.map(this.mapInvoice);
  }

  async download(
    invoiceId: string,
    requestingProfileId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { profile: true, payment_request: true, payment: true },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.profile_id !== requestingProfileId) {
      throw new ForbiddenException('Not authorized to access this invoice');
    }

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.INVOICE },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No INVOICE template found');

    const filename = `facture_${invoice.profile.last_name}_${invoice.id.slice(0, 8)}.pdf`;

    const cacheKey = `${REDIS_KEY_PREFIX}pdf:invoice:${invoiceId}:${template.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { buffer: Buffer.from(cached, 'base64'), filename };

    const reasonLabel: Record<InvoiceReason, string> = {
      CONTACT_UNLOCK: 'Déverrouillage de contact',
      PENALTY: 'Régularisation',
      WALLET_TOP_UP: 'Recharge de wallet',
      OTHER: 'Autre',
    };

    const paymentMethod = invoice.payment
      ? (PAYMENT_METHOD_LABELS[invoice.payment.payment_method] ??
        invoice.payment.payment_method)
      : await this.resolvePaymentMethod(
          invoice.payment_request?.payment_reference,
        );

    const data: Record<string, string> = {
      INVOICE_ID: this.invoiceRef(invoice.id, invoice.created_at),
      INVOICE_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
      FIRST_NAME: invoice.profile.first_name,
      LAST_NAME: invoice.profile.last_name,
      PROFILE_TYPE: invoice.profile.profile_type,
      EMAIL: invoice.profile.email ?? '-',
      PHONE: invoice.profile.phone,
      AMOUNT: invoice.amount.toString(),
      REASON: reasonLabel[invoice.reason] ?? invoice.reason,
      PAYMENT_REF:
        invoice.payment?.transaction_id ??
        invoice.payment_request?.payment_reference ??
        '',
      PAYMENT_METHOD: paymentMethod,
      RELATED_ENTITY: await this.resolveRelatedEntity(
        invoice.related_entity_type,
        invoice.related_entity_id,
        invoice.profile_id,
      ),
      GENERATED_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await Promise.all([
      this.redis.set(cacheKey, buffer.toString('base64')),
      this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'DOWNLOADED' },
      }),
    ]);

    return { buffer, filename };
  }

  async downloadAsAdmin(
    invoiceId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { profile: true, payment_request: true, payment: true },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.INVOICE },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No INVOICE template found');

    const filename = `facture_${invoice.profile.last_name}_${invoice.id.slice(0, 8)}.pdf`;

    const cacheKey = `${REDIS_KEY_PREFIX}pdf:invoice:${invoiceId}:${template.id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { buffer: Buffer.from(cached, 'base64'), filename };

    const reasonLabel: Record<InvoiceReason, string> = {
      CONTACT_UNLOCK: 'Déverrouillage de contact',
      PENALTY: 'Régularisation',
      WALLET_TOP_UP: 'Recharge de wallet',
      OTHER: 'Autre',
    };

    const paymentMethod = invoice.payment
      ? (PAYMENT_METHOD_LABELS[invoice.payment.payment_method] ??
        invoice.payment.payment_method)
      : await this.resolvePaymentMethod(
          invoice.payment_request?.payment_reference,
        );

    const data: Record<string, string> = {
      INVOICE_ID: this.invoiceRef(invoice.id, invoice.created_at),
      INVOICE_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
      FIRST_NAME: invoice.profile.first_name,
      LAST_NAME: invoice.profile.last_name,
      PROFILE_TYPE: this.getProfileTypeLabel(invoice.profile.profile_type),
      EMAIL: invoice.profile.email ?? '-',
      PHONE: invoice.profile.phone,
      AMOUNT: invoice.amount.toString(),
      REASON: reasonLabel[invoice.reason] ?? invoice.reason,
      PAYMENT_REF:
        invoice.payment?.transaction_id ??
        invoice.payment_request?.payment_reference ??
        '',
      PAYMENT_METHOD: paymentMethod,
      RELATED_ENTITY: await this.resolveRelatedEntity(
        invoice.related_entity_type,
        invoice.related_entity_id,
        invoice.profile_id,
      ),
      GENERATED_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await this.redis.set(cacheKey, buffer.toString('base64'));
    return { buffer, filename };
  }

  private mapInvoice(this: void, inv: any): InvoiceItem {
    return {
      id: inv.id,
      profileId: inv.profile_id,
      paymentRequestId: inv.payment_request_id,
      amount: inv.amount.toString(),
      reason: inv.reason,
      relatedEntityType: inv.related_entity_type ?? null,
      relatedEntityId: inv.related_entity_id ?? null,
      status: inv.status,
      createdAt: inv.created_at.toISOString(),
    };
  }

  private getProfileTypeLabel(profileType: ProfileType): string {
    return PROFILE_TYPE_LABELS[profileType] ?? (profileType as string);
  }

  private async resolveRelatedEntity(
    relatedEntityType: string | null,
    relatedEntityId: string | null,
    invoiceProfileId: string,
  ): Promise<string> {
    if (!relatedEntityId || !relatedEntityType) return '-';

    if (relatedEntityType === 'worker') {
      const worker = await this.prisma.profile.findUnique({
        where: { id: relatedEntityId },
        select: { first_name: true, last_name: true },
      });
      if (!worker) return '-';
      return `${worker.first_name} ${worker.last_name}`;
    }

    if (relatedEntityType === 'contact_unlock_attempt') {
      const attempt = await this.prisma.contactUnlockAttempt.findUnique({
        where: { id: relatedEntityId },
        include: {
          worker: { select: { first_name: true, last_name: true, id: true } },
          employer: { select: { first_name: true, last_name: true, id: true } },
        },
      });
      if (!attempt) return '-';
      const other =
        attempt.worker_id === invoiceProfileId
          ? attempt.employer
          : attempt.worker;
      return `${other.first_name} ${other.last_name}`;
    }

    return '-';
  }

  private async resolvePaymentMethod(
    paymentReference: string | null | undefined,
  ): Promise<string> {
    if (!paymentReference) return '';
    const payment = await this.prisma.payment.findUnique({
      where: { transaction_id: paymentReference },
      select: { payment_method: true },
    });
    if (!payment) return '';
    return (
      PAYMENT_METHOD_LABELS[payment.payment_method] ?? payment.payment_method
    );
  }
}
