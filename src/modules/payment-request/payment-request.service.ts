import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AccountStatus, PaymentRequestStatus, PaymentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { LogService } from '../log/log.service';
import { MailService } from '../mail/mail.service';
import {
  paymentApprovedMessage,
  paymentLinkMessage,
} from '../whatsapp/templates';
import { paymentRejectedEmail } from '../mail/templates';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { SubmitPaymentDto } from './dto/submit-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';
import { PaymentService } from '../payments/payment.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';

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

type LogAction =
  | 'PAYMENT_LINK_CREATED'
  | 'PAYMENT_APPROVED'
  | 'PAYMENT_REJECTED'
  | 'PAYMENT_CONFIRMED';

@Injectable()
export class PaymentRequestService {
  private readonly logger = new Logger(PaymentRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly whatsApp: WhatsAppService,
    private readonly log: LogService,
    private readonly mail: MailService,
    private readonly paymentService: PaymentService,
    private readonly systemConfig: SystemConfigService,
    private readonly walletService: WalletService,
  ) {}

  async createPaymentLink(dto: CreatePaymentLinkDto, adminUserId: string) {
    const profile = await this.findProfileOrThrow(dto.profileId);

    const token = randomBytes(32).toString('hex');
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    const paymentUrl = `${frontendUrl}/pay/${token}`;

    const request = await this.prisma.paymentRequest.create({
      data: {
        profile_id: dto.profileId,
        token,
        status: PaymentRequestStatus.PENDING,
      },
      select: PAYMENT_REQUEST_SELECT,
    });

    await this.createLog({
      action: 'PAYMENT_LINK_CREATED',
      entityId: request.id,
      userId: adminUserId,
      profileId: dto.profileId,
      metadata: { paymentUrl },
    });

    await this.prisma.profile.update({
      where: { id: dto.profileId },
      data: { payment_link: paymentUrl },
    });

    if (profile.phone) {
      const message = paymentLinkMessage(paymentUrl);
      await this.trySendWhatsApp(profile.phone, message, profile.id);
    }

    return { ...this.formatRequest(request), paymentUrl };
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
    };
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

  async approve(id: string, adminUserId: string) {
    const request = await this.findSubmittedRequestOrThrow(id);

    const [updated] = await this.prisma.$transaction([
      this.prisma.paymentRequest.update({
        where: { id },
        data: { status: PaymentRequestStatus.APPROVED },
        select: PAYMENT_REQUEST_SELECT,
      }),
      this.prisma.profile.update({
        where: { id: request.profile_id },
        data: { status: AccountStatus.ACTIVE },
      }),
    ]);

    await this.createLog({
      action: 'PAYMENT_APPROVED',
      entityId: id,
      userId: adminUserId,
      profileId: request.profile_id,
    });

    const fee = await this.systemConfig.getRaw('fees.application_fee_fcfa', '0');
    await this.paymentService.makePayment({
      type: PaymentType.REGISTRATION,
      profileId: request.profile_id,
      amount: Number(fee),
    });

    await this.trySendApprovedWhatsApp(request.profile);

    return this.formatRequest(updated as PaymentRequestWithProfile);
  }

  async reject(id: string, dto: RejectPaymentDto, adminUserId: string) {
    const request = await this.findSubmittedRequestOrThrow(id);

    const updated = await this.prisma.paymentRequest.update({
      where: { id },
      data: { status: PaymentRequestStatus.REJECTED, rejection_note: dto.note },
      select: PAYMENT_REQUEST_SELECT,
    });

    await this.createLog({
      action: 'PAYMENT_REJECTED',
      entityId: id,
      userId: adminUserId,
      profileId: request.profile_id,
      metadata: { note: dto.note },
    });

    await this.trySendRejectedEmail(request.profile, dto.note);

    return this.formatRequest(updated);
  }

  async manualDecide(
    profileId: string,
    decision: 'ACCEPTED' | 'REJECTED',
    reason: string | undefined,
    adminUserId: string,
  ) {
    const request = await this.prisma.paymentRequest.findFirst({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      if (decision === 'ACCEPTED') {
        await this.activateProfileWithoutRequest(profileId, adminUserId);
      }
      return null;
    }

    return decision === 'ACCEPTED'
      ? this.manualApprove(request, profileId, adminUserId)
      : this.manualReject(request, profileId, reason, adminUserId);
  }

  private async manualApprove(
    request: PaymentRequestWithProfile,
    profileId: string,
    adminUserId: string,
  ) {
    const [updated] = await this.prisma.$transaction([
      this.prisma.paymentRequest.update({
        where: { id: request.id },
        data: { status: PaymentRequestStatus.APPROVED },
        select: PAYMENT_REQUEST_SELECT,
      }),
      this.prisma.profile.update({
        where: { id: profileId },
        data: { status: AccountStatus.ACTIVE },
      }),
    ]);

    await this.createLog({
      action: 'PAYMENT_CONFIRMED',
      entityId: request.id,
      userId: adminUserId,
      profileId,
      metadata: { note: 'Payment manually confirmed by admin' },
    });

    await this.trySendApprovedWhatsApp(request.profile);

    const feeRaw = await this.systemConfig.getRaw('fees.registration_fee_fcfa', '0');
    const fee = parseFloat(feeRaw) || 0;
    if (fee > 0) {
      await this.walletService.recordRegistrationPayment(profileId, fee).catch((err) =>
        this.logger.warn(`Failed to record registration payment for ${profileId}: ${err?.message}`),
      );
    }

    return this.formatRequest(updated as PaymentRequestWithProfile);
  }

  private async manualReject(
    request: PaymentRequestWithProfile,
    profileId: string,
    reason: string | undefined,
    adminUserId: string,
  ) {
    const updated = await this.prisma.paymentRequest.update({
      where: { id: request.id },
      data: {
        status: PaymentRequestStatus.REJECTED,
        rejection_note: reason ?? null,
      },
      select: PAYMENT_REQUEST_SELECT,
    });

    await this.createLog({
      action: 'PAYMENT_REJECTED',
      entityId: request.id,
      userId: adminUserId,
      profileId,
      metadata: { reason: reason ?? null },
    });

    await this.trySendRejectedEmail(updated.profile, reason);

    return this.formatRequest(updated);
  }

  private async activateProfileWithoutRequest(
    profileId: string,
    adminUserId: string,
  ) {
    const profile = await this.prisma.profile.update({
      where: { id: profileId },
      data: { status: AccountStatus.ACTIVE },
    });

    await this.trySendApprovedWhatsApp(profile);

    await this.createLog({
      action: 'PAYMENT_CONFIRMED',
      entityType: 'Profile',
      entityId: profileId,
      userId: adminUserId,
      profileId,
      metadata: {
        note: 'Profile manually activated by admin (no payment request)',
      },
    });

    const feeRaw = await this.systemConfig.getRaw('fees.registration_fee_fcfa', '0');
    const fee = parseFloat(feeRaw) || 0;
    if (fee > 0) {
      await this.walletService.recordRegistrationPayment(profileId, fee).catch((err) =>
        this.logger.warn(`Failed to record registration payment for ${profileId}: ${err?.message}`),
      );
    }
  }

  private async findProfileOrThrow(profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { id: true, phone: true, first_name: true },
    });
    if (!profile) throw new NotFoundException('Profil non trouvé');
    return profile;
  }

  private async findSubmittedRequestOrThrow(id: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id },
      select: PAYMENT_REQUEST_SELECT,
    });
    if (!request)
      throw new NotFoundException('Demande de paiement introuvable');
    if (request.status !== PaymentRequestStatus.SUBMITTED) {
      throw new BadRequestException("Cette demande n'a pas été soumise");
    }
    return request;
  }

  private async trySendWhatsApp(
    phone: string,
    message: string,
    profileId?: string,
  ) {
    await this.whatsApp
      .sendTextMessage(phone, message, profileId)
      .catch((err: unknown) =>
        this.logger.warn(`Failed to send WhatsApp message to ${phone}:`, err),
      );
  }

  private async trySendApprovedWhatsApp(
    profile: Pick<
      PaymentRequestWithProfile['profile'],
      'phone' | 'first_name' | 'profile_type'
    >,
  ) {
    if (!profile.phone) return;
    const message = paymentApprovedMessage(profile.first_name);
    await this.trySendWhatsApp(profile.phone, message);
  }

  private async trySendRejectedEmail(
    profile: Pick<PaymentRequestWithProfile['profile'], 'email' | 'first_name'>,
    note: string | undefined,
  ) {
    if (!profile.email) return;
    await this.mail
      .sendMail({
        to: profile.email,
        subject: 'Votre demande de paiement Rabotka a été rejetée',
        html: paymentRejectedEmail(note),
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to send payment rejected email to ${profile.email}:`,
          err,
        ),
      );
  }

  private async createLog(params: {
    action: LogAction;
    entityId: string;
    userId: string;
    profileId: string;
    entityType?: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.log.create({
      action: params.action,
      entityType: params.entityType ?? 'PaymentRequest',
      entityId: params.entityId,
      userId: params.userId,
      profileId: params.profileId,
      ...(params.metadata && { metadata: params.metadata }),
    });
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
      paymentReference: r.payment_reference,
      proofImages: r.proof_images,
      rejectionNote: r.rejection_note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
