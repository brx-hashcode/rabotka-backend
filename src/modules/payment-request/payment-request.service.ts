import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AccountStatus, PaymentRequestStatus, Prisma } from '@prisma/client';
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

type PaymentRequestWithProfile = Prisma.PaymentRequestGetPayload<{
  select: typeof PAYMENT_REQUEST_SELECT;
}>;

@Injectable()
export class PaymentRequestService {
  private readonly logger = new Logger(PaymentRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly whatsApp: WhatsAppService,
    private readonly log: LogService,
    private readonly mail: MailService,
  ) {}

  // ─── Admin: Create payment link ─────────────────────────────────────────

  async createPaymentLink(dto: CreatePaymentLinkDto, adminUserId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: dto.profileId },
      select: { id: true, phone: true, first_name: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const token = randomBytes(32).toString('hex');
    const frontendUrl = this.config.get<string>('FRONTEND_URL', '');
    const paymentUrl = `${frontendUrl}/pay/${token}`;

    const request: PaymentRequestWithProfile =
      await this.prisma.paymentRequest.create({
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
      const message: string = paymentLinkMessage(
        profile.first_name,
        paymentUrl,
      );
      await this.whatsApp
        .sendTextMessage(profile.phone, message, profile.id)
        .catch(() => null);
    }

    const formatted = this.formatRequest(request);
    return { ...formatted, paymentUrl };
  }

  // ─── Admin: Get payment requests by profile ──────────────────────────────

  async getByProfileId(profileId: string) {
    const requests = await this.prisma.paymentRequest.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      select: PAYMENT_REQUEST_SELECT,
    });
    return requests.map((r: PaymentRequestWithProfile) =>
      this.formatRequest(r),
    );
  }

  // ─── Public: Get payment info by token ──────────────────────────────────

  async getByToken(token: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { token },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (
      request.status === PaymentRequestStatus.APPROVED ||
      request.status === PaymentRequestStatus.REJECTED
    ) {
      throw new BadRequestException('Cette demande a déjà été traitée');
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
      data: requests.map((r: PaymentRequestWithProfile) =>
        this.formatRequest(r),
      ),
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
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (request.status !== PaymentRequestStatus.SUBMITTED) {
      throw new BadRequestException("Cette demande n'a pas été soumise");
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
      const message: string = paymentApprovedMessage(
        request.profile.first_name,
        request.profile.profile_type as 'WORKER' | 'EMPLOYER',
      );
      const phone: string = request.profile.phone;
      await this.whatsApp.sendTextMessage(phone, message);
    }

    return this.formatRequest(updated as PaymentRequestWithProfile);
  }

  // ─── Admin: Reject ────────────────────────────────────────────────────────

  async reject(id: string, dto: RejectPaymentDto, adminUserId: string) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id },
      select: PAYMENT_REQUEST_SELECT,
    });

    if (!request) {
      throw new NotFoundException('Demande de paiement introuvable');
    }

    if (request.status !== PaymentRequestStatus.SUBMITTED) {
      throw new BadRequestException("Cette demande n'a pas été soumise");
    }

    const updated: PaymentRequestWithProfile =
      await this.prisma.paymentRequest.update({
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

    if (request.profile.email) {
      await this.mail
        .sendMail({
          to: request.profile.email,
          subject: 'Votre demande de paiement Rabotka a été rejetée',
          html: paymentRejectedEmail(request.profile.first_name, dto.note),
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to send payment rejected email to ${request.profile.email}:`,
            err,
          ),
        );
    }

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
        const profile = await this.prisma.profile.update({
          where: { id: profileId },
          data: { status: AccountStatus.ACTIVE },
        });

        if (profile.phone) {
          const message: string = paymentApprovedMessage(
            profile.first_name,
            profile.profile_type as 'WORKER' | 'EMPLOYER',
          );

          const phone: string = profile.phone;
          await this.whatsApp.sendTextMessage(phone, message);
        }

        await this.log.create({
          action: 'PAYMENT_CONFIRMED',
          entityType: 'Profile',
          entityId: profileId,
          userId: adminUserId,
          profileId,
          metadata: {
            note: 'Profile manually activated by admin (no payment request)',
          },
        });
      }
      return null;
    }

    if (decision === 'ACCEPTED') {
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

      await this.log.create({
        action: 'PAYMENT_CONFIRMED',
        entityType: 'PaymentRequest',
        entityId: request.id,
        userId: adminUserId,
        profileId,
        metadata: { note: 'Payment manually confirmed by admin' },
      });

      if (request.profile.phone) {
        const message: string = paymentApprovedMessage(
          request.profile.first_name,
          request.profile.profile_type as 'WORKER' | 'EMPLOYER',
        );
        const phone: string = request.profile.phone;
        await this.whatsApp
          .sendTextMessage(phone, message)
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to send payment approved message to ${phone}:`,
              err,
            ),
          );
      }

      return this.formatRequest(updated as PaymentRequestWithProfile);
    } else {
      const updated: PaymentRequestWithProfile =
        await this.prisma.paymentRequest.update({
          where: { id: request.id },
          data: {
            status: PaymentRequestStatus.REJECTED,
            rejection_note: reason ?? null,
          },
          select: PAYMENT_REQUEST_SELECT,
        });

      await this.log.create({
        action: 'PAYMENT_REJECTED',
        entityType: 'PaymentRequest',
        entityId: request.id,
        userId: adminUserId,
        profileId,
        metadata: { reason: reason ?? null },
      });

      if (updated.profile.email) {
        await this.mail
          .sendMail({
            to: updated.profile.email,
            subject: 'Votre demande de paiement Rabotka a été rejetée',
            html: paymentRejectedEmail(updated.profile.first_name, reason),
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `Failed to send payment rejected email to ${updated.profile.email}:`,
              err,
            ),
          );
      }

      return this.formatRequest(updated);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private formatRequest(r: PaymentRequestWithProfile) {
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
