import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AccountStatus, PaymentRequestStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { LogService } from '../log/log.service';
import { paymentApprovedMessage, paymentLinkMessage } from '../whatsapp/templates';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { SubmitPaymentDto } from './dto/submit-payment.dto';
import { RejectPaymentDto } from './dto/reject-payment.dto';
import { ListPaymentRequestsDto } from './dto/list-payment-requests.dto';

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
};

@Injectable()
export class PaymentRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly whatsApp: WhatsAppService,
    private readonly log: LogService,
  ) {}

  // ─── Admin: Create payment link ─────────────────────────────────────────

  async createPaymentLink(dto: CreatePaymentLinkDto, adminUserId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: dto.profileId },
      select: { id: true, phone: true, first_name: true },
    });

    if (!profile) {
      throw new NotFoundException('profile.errors.not_found');
    }

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

    await this.log.create({
      action: 'PAYMENT_LINK_CREATED',
      entityType: 'PaymentRequest',
      entityId: request.id,
      userId: adminUserId,
      profileId: dto.profileId,
      metadata: { paymentUrl },
    });

    // Send via WhatsApp if profile has a phone
    if (profile.phone) {
      const message = paymentLinkMessage(profile.first_name, paymentUrl);
      await this.whatsApp
        .sendTextMessage(profile.phone, message, profile.id)
        .catch(() => null);
    }

    return { ...this.formatRequest(request), paymentUrl };
  }

  // ─── Admin: Get payment requests by profile ──────────────────────────────

  async getByProfileId(profileId: string) {
    const requests = await this.prisma.paymentRequest.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      select: PAYMENT_REQUEST_SELECT,
    });
    return requests.map((r) => this.formatRequest(r));
  }

  // ─── Public: Get payment info by token ──────────────────────────────────

  async getByToken(token: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('payment_request.errors.not_found');
    }

    if (
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      throw new BadRequestException('payment_request.errors.already_processed');
    }

    return {
      id: request.id,
      status: request.status,
      profileName: `${request.profile.first_name} ${request.profile.last_name}`,
    };
  }

  // ─── Public: Submit payment proof ────────────────────────────────────────

  async submitPayment(token: string, dto: SubmitPaymentDto) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
    });

    if (!request) {
      throw new NotFoundException('payment_request.errors.not_found');
    }

    if (request.status !== PaymentRequestStatus.PENDING) {
      throw new BadRequestException('payment_request.errors.not_pending');
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

  // ─── Admin: List payment requests ────────────────────────────────────────

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

  // ─── Admin: Approve ───────────────────────────────────────────────────────

  async approve(id: string, adminUserId: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('payment_request.errors.not_found');
    }

    if (request.status !== PaymentRequestStatus.SUBMITTED) {
      throw new BadRequestException('payment_request.errors.not_submitted');
    }

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

    await this.log.create({
      action: 'PAYMENT_APPROVED',
      entityType: 'PaymentRequest',
      entityId: id,
      userId: adminUserId,
      profileId: request.profile_id,
    });

    // Send WhatsApp notification if connected
    if (request.profile.phone) {
      const message = paymentApprovedMessage(
        request.profile.first_name,
        request.profile.profile_type as 'WORKER' | 'EMPLOYER',
      );
      await this.whatsApp.sendTextMessage(request.profile.phone, message);
    }

    return this.formatRequest(updated);
  }

  // ─── Admin: Reject ────────────────────────────────────────────────────────

  async reject(id: string, dto: RejectPaymentDto, adminUserId: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('payment_request.errors.not_found');
    }

    if (request.status !== PaymentRequestStatus.SUBMITTED) {
      throw new BadRequestException('payment_request.errors.not_submitted');
    }

    const updated = await this.prisma.paymentRequest.update({
      where: { id },
      data: {
        status: PaymentRequestStatus.REJECTED,
        rejection_note: dto.note,
      },
      select: PAYMENT_REQUEST_SELECT,
    });

    await this.log.create({
      action: 'PAYMENT_REJECTED',
      entityType: 'PaymentRequest',
      entityId: id,
      userId: adminUserId,
      profileId: request.profile_id,
      metadata: { note: dto.note },
    });

    return this.formatRequest(updated);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private formatRequest(r: {
    id: string;
    created_at: Date;
    updated_at: Date;
    profile_id: string;
    token: string;
    status: PaymentRequestStatus;
    payment_reference: string | null;
    proof_images: string[];
    rejection_note: string | null;
    profile: {
      id: string;
      first_name: string;
      last_name: string;
      email: string;
      phone: string;
      status: AccountStatus;
      profile_type: string;
    };
  }) {
    return {
      id: r.id,
      profileId: r.profile_id,
      profileName: `${r.profile.first_name} ${r.profile.last_name}`,
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
