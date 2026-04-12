import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { DocumentService } from '../document/document.service';
import {
  DocumentCategory,
  InvoiceReason,
  PaymentMethod,
  ProfileType,
} from '@prisma/client';

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
  paymentRequestId: string;
  amount: string;
  reason: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  status: string;
  createdAt: string;
};

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentService: DocumentService,
  ) {}

  private invoiceRef(id: string, createdAt: Date): string {
    const year = createdAt.getFullYear();
    const short = id.replaceAll('-', '').slice(0, 8).toUpperCase();
    return `RBT-${year}-${short}`;
  }

  async create(params: {
    profileId: string;
    paymentRequestId: string;
    amount: number;
    reason: InvoiceReason;
    relatedEntityType?: string;
    relatedEntityId?: string;
  }): Promise<InvoiceItem> {
    const existing = await this.prisma.invoice.findUnique({
      where: { payment_request_id: params.paymentRequestId },
    });
    if (existing) return this.mapInvoice(existing);

    const invoice = await this.prisma.invoice.create({
      data: {
        profile_id: params.profileId,
        payment_request_id: params.paymentRequestId,
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
      include: { profile: true, payment_request: true },
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

    const reasonLabel: Record<InvoiceReason, string> = {
      CONTACT_UNLOCK: 'Déverrouillage de contact',
      PENALTY: 'Pénalité',
      OTHER: 'Autre',
    };

    const paymentMethod = await this.resolvePaymentMethod(
      invoice.payment_request?.payment_reference,
    );

    const data: Record<string, string> = {
      INVOICE_ID: this.invoiceRef(invoice.id, invoice.created_at),
      INVOICE_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
      FIRST_NAME: invoice.profile.first_name,
      LAST_NAME: invoice.profile.last_name,
      PROFILE_TYPE: invoice.profile.profile_type,
      EMAIL: invoice.profile.email,
      PHONE: invoice.profile.phone,
      AMOUNT: invoice.amount.toString(),
      REASON: reasonLabel[invoice.reason] ?? invoice.reason,
      PAYMENT_REF: invoice.payment_request?.payment_reference ?? '',
      PAYMENT_METHOD: paymentMethod,
      RELATED_ENTITY: invoice.related_entity_id ?? '',
      GENERATED_DATE: new Date().toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'DOWNLOADED' },
    });

    const filename = `facture_${invoice.profile.last_name}_${invoice.id.slice(0, 8)}.pdf`;
    return { buffer, filename };
  }

  async downloadAsAdmin(
    invoiceId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { profile: true, payment_request: true },
    });

    if (!invoice) throw new NotFoundException('Invoice not found');

    const template = await this.prisma.document.findFirst({
      where: { category: DocumentCategory.INVOICE },
      orderBy: { created_at: 'desc' },
    });
    if (!template) throw new NotFoundException('No INVOICE template found');

    const reasonLabel: Record<InvoiceReason, string> = {
      CONTACT_UNLOCK: 'Déverrouillage de contact',
      PENALTY: 'Pénalité',
      OTHER: 'Autre',
    };

    const paymentMethod = await this.resolvePaymentMethod(
      invoice.payment_request?.payment_reference,
    );

    const data: Record<string, string> = {
      INVOICE_ID: this.invoiceRef(invoice.id, invoice.created_at),
      INVOICE_DATE: new Date(invoice.created_at).toLocaleDateString('fr-FR'),
      FIRST_NAME: invoice.profile.first_name,
      LAST_NAME: invoice.profile.last_name,
      PROFILE_TYPE: this.getProfileTypeLabel(invoice.profile.profile_type),
      EMAIL: invoice.profile.email,
      PHONE: invoice.profile.phone,
      AMOUNT: invoice.amount.toString(),
      REASON: reasonLabel[invoice.reason] ?? invoice.reason,
      PAYMENT_REF: invoice.payment_request?.payment_reference ?? '',
      PAYMENT_METHOD: paymentMethod,
      RELATED_ENTITY: invoice.related_entity_id ?? '',
      GENERATED_DATE: new Date().toLocaleDateString('fr-FR'),
    };

    const buffer = await this.documentService.fillDocumentTemplateAsPdf(
      template.id,
      data,
    );
    const filename = `facture_${invoice.profile.last_name}_${invoice.id.slice(0, 8)}.pdf`;
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
