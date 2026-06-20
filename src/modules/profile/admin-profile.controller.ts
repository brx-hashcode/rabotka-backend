import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  Res,
  UseInterceptors,
  UploadedFiles,
  UploadedFile,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PaymentRequestService } from '../payment-request/payment-request.service';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { kycApprovedEmail, kycRejectedEmail } from '../mail/templates';
import { formatKycValidatedMessage } from '../bot/messages/notifications.messages';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { AdminListProfilesDto } from './dto/admin-list-profiles.dto';
import {
  AdminVerifyProfileDto,
  VerifyDecision,
} from './dto/admin-verify-profile.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { AdminUpdateProfileDto } from './dto/admin-update-profile.dto';

@ApiTags('Admin – Profiles')
@Controller('admin/profiles')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminProfileController {
  constructor(
    private readonly profileService: ProfileService,
    private readonly logService: LogService,
    private readonly paymentRequestService: PaymentRequestService,
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly walletService: WalletService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List profiles (admin only)',
    description: 'Returns paginated profiles with optional search and filters.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of profiles' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListProfilesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return await this.profileService.getProfilesForAdmin({
      page,
      limit,
      q: dto.q,
      status: dto.status,
      profileType: dto.profile_type,
      whatsappConnected: dto.whatsapp_connected,
      verificationStatus: dto.verification_status,
    });
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get profile details (admin only)',
    description: 'Returns full profile details including KYC documents.',
  })
  @ApiResponse({ status: 200, description: 'Profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async getById(@Param('id') id: string) {
    return await this.profileService.getProfileDetailForAdmin(id);
  }

  @Get(':id/logs')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get profile audit logs (admin only)',
    description: 'Returns the audit trail / timeline for a profile.',
  })
  @ApiResponse({ status: 200, description: 'List of log entries' })
  async getLogs(@Param('id') id: string) {
    return await this.logService.getByProfileId(id);
  }

  @Get(':id/payment-requests')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get payment requests for a profile (admin only)' })
  async getPaymentRequests(@Param('id') id: string) {
    return await this.paymentRequestService.getByProfileId(id);
  }

  @Get(':id/wallet')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get wallet balance and transactions for a profile (admin only)',
  })
  async getWallet(@Param('id') id: string) {
    return await this.walletService.getProfileWalletForAdmin(id);
  }

  @Post(':id/wallet/credit')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Manually credit a profile wallet (admin only)' })
  async creditWallet(
    @Param('id') id: string,
    @Body() body: { amount: number; note?: string },
    @Req() req: any,
  ) {
    const { amount, note } = body;
    if (!amount || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    const profile = await this.prisma.profile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException('Profile not found');

    const refType = note ? `admin_manual — ${note}` : 'admin_manual';
    await this.walletService.creditProfileWallet(
      id,
      amount,
      'MANUAL_CREDIT' as any,
      refType,
    );

    await this.logService.create({
      action: 'WALLET_MANUAL_CREDIT',
      entityType: 'Profile',
      entityId: id,
      userId: req.user?.userId,
      profileId: id,
      metadata: { amount, note: note ?? null },
    });

    return { success: true };
  }

  @Get(':id/invoices')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get invoices for a profile (admin only)' })
  async getInvoices(@Param('id') id: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: { profile_id: id },
      orderBy: { created_at: 'desc' },
    });
    return invoices.map((inv) => ({
      id: inv.id,
      profileId: inv.profile_id,
      paymentRequestId: inv.payment_request_id,
      amount: inv.amount.toString(),
      reason: inv.reason,
      relatedEntityType: inv.related_entity_type ?? null,
      relatedEntityId: inv.related_entity_id ?? null,
      status: inv.status,
      createdAt: inv.created_at.toISOString(),
    }));
  }

  @Get(':id/messages')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get messages for a profile (admin only)' })
  async getMessages(@Param('id') id: string) {
    const messages = await this.prisma.message.findMany({
      where: { profile_id: id },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        created_at: true,
        direction: true,
        platform: true,
        body: true,
        sent_by: { select: { first_name: true, last_name: true } },
      },
    });
    return messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      platform: m.platform,
      body: m.body,
      createdAt: m.created_at,
      sentByName: m.sent_by
        ? `${m.sent_by.first_name} ${m.sent_by.last_name}`
        : null,
    }));
  }

  @Post(':id/messages')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Send a message to a profile (admin only)' })
  @UseInterceptors(FilesInterceptor('attachments', 5))
  async sendMessage(
    @Param('id') id: string,
    @Body() body: { channel: 'WHATSAPP' | 'EMAIL'; message: string },
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Req() req: any,
  ) {
    const adminUserId: string | undefined = req.user?.userId;
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true, phone: true, email: true, first_name: true },
    });

    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    if (!body.message?.trim()) {
      throw new BadRequestException('Le message ne peut pas être vide');
    }

    let adminFullName = "L'équipe Rabotka";
    if (adminUserId) {
      const admin = await this.prisma.user.findUnique({
        where: { id: adminUserId },
        select: { first_name: true, last_name: true },
      });
      if (admin) {
        adminFullName = `${admin.first_name} ${admin.last_name}`.trim();
      }
    }

    if (body.channel === 'WHATSAPP') {
      await this.sendWhatsAppMessage(
        profile,
        body.message,
        adminFullName,
        adminUserId,
      );
    } else {
      await this.sendEmailMessage(
        profile,
        body.message,
        adminFullName,
        files,
        adminUserId,
      );
    }

    await this.logService.create({
      action: 'PROFILE_MESSAGE_SENT',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {
        channel: body.channel,
        attachmentsCount: files?.length ?? 0,
      },
      ...extractRequestMeta(req),
    });

    return { success: true };
  }

  private async sendWhatsAppMessage(
    profile: { id: string; phone: string | null },
    message: string,
    adminFullName: string,
    adminUserId: string | undefined,
  ): Promise<void> {
    if (!profile.phone) {
      throw new BadRequestException("Ce profil n'a pas de numéro de téléphone");
    }
    const whatsappBody = [
      message.trim(),
      '',
      `_${adminFullName}_`,
      `_L'équipe Rabotka_`,
    ].join('\n');
    await this.whatsApp.sendTextMessage(
      profile.phone,
      whatsappBody,
      profile.id,
      adminUserId,
    );
    await this.prisma.message.create({
      data: {
        profile_id: profile.id,
        direction: MessageDirection.OUTBOUND,
        platform: BotPlatform.WHATSAPP,
        body: whatsappBody,
      },
    });
  }

  private async sendEmailMessage(
    profile: { id: string; email: string | null },
    message: string,
    adminFullName: string,
    files: Express.Multer.File[] | undefined,
    adminUserId: string | undefined,
  ): Promise<void> {
    if (!profile.email) {
      throw new BadRequestException("Ce profil n'a pas d'adresse email");
    }
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    const oversized = files?.find((f) => f.size > MAX_FILE_SIZE);
    if (oversized) {
      throw new BadRequestException(
        `File "${oversized.originalname}" exceeds the 10 MB limit`,
      );
    }
    const attachments =
      files?.map((f) => ({
        filename: f.originalname,
        content: f.buffer,
        contentType: f.mimetype,
      })) ?? [];
    const messageHtml = message.trim().replaceAll('\n', '<br/>');
    const html = await this.layout.wrap(
      `<p>${messageHtml}</p><br/><p>${adminFullName}<br/>L'équipe Rabotka</p>`,
    );
    await this.mail.sendMail({
      to: profile.email,
      subject: 'Message de Rabotka',
      html,
      ...(attachments.length > 0 && { attachments }),
    });
    await this.prisma.message.create({
      data: {
        profile_id: profile.id,
        direction: MessageDirection.OUTBOUND,
        platform: BotPlatform.EMAIL,
        body: message.trim(),
        ...(adminUserId ? { sent_by_id: adminUserId } : {}),
      },
    });
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update profile fields (admin only)',
    description: 'Updates profile fields like name, description, address.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: AdminUpdateProfileDto,
    @Req() req: any,
  ) {
    const result = await this.profileService.updateProfileByAdmin(id, dto);
    const adminUserId = req.user?.userId;
    await this.logService.create({
      action: 'PROFILE_UPDATED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: { fields: dto },
    });
    return result;
  }

  @Patch(':id/avatar')
  @Roles(UserRole.MANAGER)
  @UseInterceptors(
    FileInterceptor('avatar', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(
            new BadRequestException(
              'Only JPEG, PNG or WEBP images are allowed',
            ),
            false,
          );
        }
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Update profile avatar (admin only)' })
  @ApiResponse({ status: 200, description: 'Avatar updated' })
  async updateAvatar(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: any,
  ) {
    if (!file) throw new BadRequestException('No avatar file provided');
    const result = await this.profileService.updateAvatar(id, file);
    const adminUserId = req.user?.userId;
    await this.logService.create({
      action: 'PROFILE_AVATAR_UPDATED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {},
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Patch(':id/verify')
  @Roles(UserRole.MANAGER)
  @UseInterceptors(FilesInterceptor('files', 10))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Verify or reject profile KYC (admin only)',
    description:
      'Approves or rejects KYC verification for a profile and its documents. Supports uploading verification images.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verify(
    @Param('id') id: string,
    @Body() dto: AdminVerifyProfileDto,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: any,
  ) {
    const adminUserId = req.user?.userId ?? 'system';
    const result = await this.profileService.verifyProfileKyc(
      id,
      adminUserId as string,
      dto.decision,
      dto.reason,
      files,
    );

    await this.logService.create({
      action:
        dto.decision === VerifyDecision.VERIFIED
          ? 'KYC_APPROVED'
          : 'KYC_REJECTED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {
        decision: dto.decision,
        reason: dto.reason,
      },
    });

    const fullName = `${result.firstName} ${result.lastName}`.trim();

    if (dto.decision === VerifyDecision.VERIFIED) {
      await this.mail.sendMail({
        to: result.email,
        subject: 'Votre vérification KYC a été approuvée',
        html: await this.layout.wrap(kycApprovedEmail(fullName)),
      });

      this.whatsApp
        .sendTextMessage(
          result.phone,
          formatKycValidatedMessage(
            result.firstName,
            result.profileType as 'WORKER' | 'EMPLOYER',
          ),
        )
        .catch((err) =>
          console.warn(
            `Failed to send KYC validated WhatsApp message for ${id}:`,
            err,
          ),
        );
    } else {
      await this.mail.sendMail({
        to: result.email,
        subject: 'Votre vérification KYC a été rejetée',
        html: await this.layout.wrap(kycRejectedEmail(fullName, dto.reason)),
      });
    }

    return result;
  }

  @Patch(':id/status')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update profile account status (admin only)',
    description:
      'Changes the account status (ACTIVE, SUSPENDED, BANNED, etc.).',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: AdminUpdateStatusDto,
    @Req() req: any,
  ) {
    const result = await this.profileService.updateProfileStatusByAdmin(
      id,
      dto.status,
    );

    const adminUserId = req.user?.userId;
    await this.logService.create({
      action: 'PROFILE_STATUS_UPDATED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {
        newStatus: dto.status,
        ...(dto.reason ? { reason: dto.reason } : {}),
      },
      ...extractRequestMeta(req),
    });

    return result;
  }

  @Post(':id/send-verification-link')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Resend WhatsApp verification link (admin only)',
    description:
      'Generates a new WhatsApp verification token and sends the link to the profile phone number.',
  })
  @ApiResponse({ status: 200, description: 'Verification link sent' })
  async sendVerificationLink(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.profileService.requestWhatsAppVerification(id);
    await this.logService.create({
      action: 'PROFILE_VERIFICATION_LINK_SENT',
      entityType: 'Profile',
      entityId: id,
      userId: req.user?.userId,
      profileId: id,
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get(':id/agreement/download')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary:
      'Download the platform agreement prefilled with profile data (admin only)',
  })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  @ApiResponse({
    status: 404,
    description: 'No agreement template found or profile not found',
  })
  async downloadProfileAgreement(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } =
      await this.profileService.downloadAgreement(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
