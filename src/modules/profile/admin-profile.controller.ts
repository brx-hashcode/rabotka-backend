import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
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
  ServiceUnavailableException,
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
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
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
import type { AdminMessageDelivery } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { kycApprovedEmail, kycRejectedEmail } from '../mail/templates';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { KYC_REJECTED_CTA_PATH } from '../../common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { AdminListProfilesDto } from './dto/admin-list-profiles.dto';
import {
  AdminVerifyProfileDto,
  VerifyDecision,
} from './dto/admin-verify-profile.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { AdminUpdateProfileDto } from './dto/admin-update-profile.dto';
import { PortfolioService } from '../portfolio/portfolio.service';
import { UpdatePortfolioItemDto } from '../portfolio/dto/update-portfolio-item.dto';

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
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly walletService: WalletService,
    private readonly portfolioService: PortfolioService,
    private readonly archiveService: ArchiveService,
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
      deleted: dto.deleted,
    });
  }

  @Post('bulk-restore')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk restore archived rows (admin only)',
    description:
      'Clears deleted_at. Only rows that are currently archived are affected.',
  })
  @ApiResponse({ status: 201, description: 'Rows restored' })
  async bulkRestore(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.restore('profiles', dto.ids);
    await this.logService.create({
      action: 'PROFILE_BULK_RESTORED',
      entityType: 'Profile',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-purge')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Permanently delete archived rows (SUPER_ADMIN only)',
    description:
      'Irreversible. Refuses rows carrying records that must outlive them (financial or compliance), returning 409 with the blocking counts.',
  })
  @ApiResponse({ status: 201, description: 'Rows permanently deleted' })
  @ApiResponse({ status: 409, description: 'Blocked by linked records' })
  async bulkPurge(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.purge('profiles', dto.ids);
    await this.logService.create({
      action: 'PROFILE_BULK_PURGED',
      entityType: 'Profile',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-delete')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk archive profiles (admin only)',
    description: 'Soft-deletes (archives) the given profiles.',
  })
  @ApiResponse({ status: 201, description: 'Profiles archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.profileService.bulkSoftDeleteProfiles(dto.ids);
    await this.logService.create({
      action: 'PROFILE_BULK_DELETED',
      entityType: 'Profile',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
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

  // ADMIN, not MANAGER like the rest of this controller: this moves real money
  // into an account. It is also what makes it safe to grant SUPPORT `full` on
  // `admin/profiles` — support needs to verify identities and edit profiles,
  // and lateral roles are capped at MANAGER, so raising this one handler keeps
  // crediting out of reach without narrowing anything else.
  @Post(':id/wallet/credit')
  @Roles(UserRole.ADMIN)
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

  @Get(':id/whatsapp-window')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: "Whether the profile's 24h WhatsApp window is open (admin only)",
    description:
      'Tells the composer which delivery mode a WhatsApp message would use. ' +
      'Advisory only — the window can open or lapse between this call and the ' +
      'send, so the send path recomputes it and is authoritative.',
  })
  async getWhatsAppWindow(@Param('id') id: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true, phone: true },
    });
    if (!profile) {
      throw new NotFoundException('Profil non trouvé');
    }

    const { open, lastInboundAt } = await this.whatsApp.isServiceWindowOpen(id);

    return {
      windowOpen: open,
      lastInboundAt,
      mode: open ? 'FREE_FORM' : 'TEMPLATE',
      hasPhone: !!profile.phone,
    };
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

    let delivery: AdminMessageDelivery | undefined;
    if (body.channel === 'WHATSAPP') {
      delivery = await this.sendWhatsAppMessage(
        profile,
        body.message,
        adminUserId,
      );
    } else {
      await this.sendEmailMessage(profile, body.message, files, adminUserId);
    }

    // Logged before the throw below: a message that failed to reach the profile
    // is exactly the event you want on the timeline.
    await this.logService.create({
      action: 'PROFILE_MESSAGE_SENT',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {
        channel: body.channel,
        attachmentsCount: files?.length ?? 0,
        deliveryMode: delivery?.mode ?? null,
        success: delivery?.sent ?? true,
        ...(delivery?.sent === false ? { failureReason: delivery.error } : {}),
      },
      ...extractRequestMeta(req),
    });

    if (delivery && !delivery.sent) {
      // 503, not 400: the failure is upstream (Twilio credentials, a Meta
      // rejection, the sandbox cap), not something the admin typed wrong. This
      // endpoint used to return success here and the message simply vanished.
      throw new ServiceUnavailableException(
        `Le message n'a pas pu être remis sur WhatsApp. ${delivery.error ?? ''}`.trim(),
      );
    }

    return { success: true, deliveryMode: delivery?.mode ?? null };
  }

  private async sendWhatsAppMessage(
    profile: { id: string; phone: string | null },
    message: string,
    adminUserId: string | undefined,
  ): Promise<AdminMessageDelivery> {
    if (!profile.phone) {
      throw new BadRequestException("Ce profil n'a pas de numéro de téléphone");
    }
    // sendAdminMessage owns the whole WhatsApp side: it picks free-form vs the
    // approved template from the 24h service window, formats the body (the same
    // shape either way) and persists the OUTBOUND Message itself. We must NOT
    // create a second one here — doing so made every admin WhatsApp message show
    // up twice in the conversation. Unlike the rest of WhatsAppService it hands
    // failures back rather than swallowing them, which is what the caller turns
    // into a 503.
    return this.whatsApp.sendAdminMessage({
      phone: profile.phone,
      profileId: profile.id,
      message,
      adminUserId,
    });
  }

  private async sendEmailMessage(
    profile: { id: string; email: string | null },
    message: string,
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
      // Signed by the team, not the individual admin — same reason the WhatsApp
      // template dropped its name variable: Rabotka answers as one team, and the
      // two channels must not sign the same message differently.
      `<p>${messageHtml}</p><br/><p>L'équipe Rabotka</p>`,
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

  // ── Portfolio (worker realizations) ─────────────────────────────────────────
  // Admins can view / edit / delete a worker's portfolio, but NOT create it —
  // workers create their own. All routes reuse PortfolioService, which scopes by
  // the profile id, so the admin acts only on that worker's items.

  @Get(':id/portfolio')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get a worker portfolio (admin only)',
    description:
      'Returns the worker portfolio items with their image galleries.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio items' })
  async getPortfolio(@Param('id') id: string) {
    return await this.portfolioService.listOwn(id);
  }

  @Patch(':id/portfolio/:itemId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update a portfolio item (admin only)',
    description: 'Updates a portfolio item title/description for a worker.',
  })
  @ApiResponse({ status: 200, description: 'Updated portfolio item' })
  @ApiResponse({ status: 404, description: 'Portfolio item not found' })
  async updatePortfolioItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdatePortfolioItemDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.portfolioService.updateItem(id, itemId, dto);
    await this.logService.create({
      action: 'PORTFOLIO_ITEM_UPDATED',
      entityType: 'PortfolioItem',
      entityId: itemId,
      userId: req.user?.userId,
      profileId: id,
      metadata: { fields: dto },
    });
    return result;
  }

  @Delete(':id/portfolio/:itemId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Delete a portfolio item (admin only)',
    description: 'Deletes a portfolio item and all its images for a worker.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio item deleted' })
  @ApiResponse({ status: 404, description: 'Portfolio item not found' })
  async deletePortfolioItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    await this.portfolioService.deleteItem(id, itemId);
    await this.logService.create({
      action: 'PORTFOLIO_ITEM_DELETED',
      entityType: 'PortfolioItem',
      entityId: itemId,
      userId: req.user?.userId,
      profileId: id,
    });
    return { success: true };
  }

  @Delete(':id/portfolio/:itemId/images/:imageId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Delete a portfolio image (admin only)',
    description: 'Removes a single image from a worker portfolio item.',
  })
  @ApiResponse({ status: 200, description: 'Portfolio image deleted' })
  @ApiResponse({
    status: 404,
    description: 'Portfolio item or image not found',
  })
  async deletePortfolioImage(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Param('imageId') imageId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    await this.portfolioService.removeImage(id, itemId, imageId);
    await this.logService.create({
      action: 'PORTFOLIO_IMAGE_DELETED',
      entityType: 'PortfolioImage',
      entityId: imageId,
      userId: req.user?.userId,
      profileId: id,
    });
    return { success: true };
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
        .sendTemplateMessage(result.phone, 'kyc', result.firstName)
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

      // The rejection used to go out by email only, and `email` is nullable on
      // a profile while `phone` is not — so the people whose documents failed
      // were the ones least likely to hear why.
      // Minted here for the same reason as the suspension send: this goes
      // straight to the provider, never through the outbound queue, so
      // nothing else fills the CTA's variable. Null degrades to the bare
      // path, which lands on the login screen rather than dead.
      const loginCode = await this.loginLink
        .mint(id, KYC_REJECTED_CTA_PATH)
        .catch(() => null);

      this.whatsApp
        .sendTemplateMessage(result.phone, 'kycRejected', {
          firstName: result.firstName,
          reason: dto.reason,
          loginCode,
        })
        .catch((err) =>
          console.warn(
            `Failed to send KYC rejected WhatsApp message for ${id}:`,
            err,
          ),
        );
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
      dto.reason,
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
