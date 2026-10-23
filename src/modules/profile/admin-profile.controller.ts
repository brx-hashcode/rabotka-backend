import { EventEmitter2 } from '@nestjs/event-emitter';
import { notifyProfile } from '../profile-notification/profile-notification.events';
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
  Optional,
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
import { ProfileFilesService } from './profile-files.service';
import { ArchiveService } from '../admin-archive/archive.service';
import { AdminContactRecordService } from '../contact-unlock/admin-contact-record.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { imageMulterOptions } from '../../common/utils/image-upload.util';
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
import {
  businessApprovedEmail,
  businessDocumentRejectedEmail,
  businessRejectedEmail,
  kycApprovedEmail,
  kycRejectedEmail,
} from '../mail/templates';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { KYC_REJECTED_CTA_PATH } from '../../common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { NotificationDispatcher } from '../notification-dispatch/notification-dispatcher.service';
import { BotPauseService } from '../bot/services/bot-pause.service';
import {
  kycApprovedFreeForm,
  kycRejectedFreeForm,
} from '../bot/messages/notifications.messages';
import { AdminListProfilesDto } from './dto/admin-list-profiles.dto';
import {
  AdminVerifyProfileDto,
  VerifyDecision,
} from './dto/admin-verify-profile.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { AdminVerifyBusinessDto } from './dto/admin-verify-business.dto';
import {
  businessDashboardUrl,
  businessOrganisationUrl,
} from '../mail/audience';
import { UpdateBusinessDto } from '../business/dto/update-business.dto';
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
    // Appended rather than slotted in: specs construct this controller
    // positionally, so a mid-list parameter shifts every mock after it.
    private readonly adminContactRecords: AdminContactRecordService,
    // Window-aware sending. Appended and @Optional() for the same positional
    // reason; without it the KYC rejection goes out as its template, which is
    // what this controller did before the dispatcher existed.
    @Optional()
    private readonly dispatcher?: NotificationDispatcher,
    // Appended and @Optional() for the same positional reason as the
    // dispatcher above: specs build this controller by position.
    @Optional()
    private readonly botPause?: BotPauseService,
    // Same positional reason. Without it a purge still deletes the rows; only
    // the files are left in storage, as before.
    @Optional()
    private readonly profileFiles?: ProfileFilesService,
    // In-app notifications. Optional for the same positional reason.
    @Optional()
    private readonly events?: EventEmitter2,
  ) {}

  /**
   * The KYC rejection, sent the cheap way when the window allows it.
   *
   * Worth the free path despite being low volume: someone whose documents were
   * refused usually writes back within the hour to ask why, so this lands in a
   * chat that is open — and the reply that follows is free too.
   */
  private async notifyRejection(
    result: { phone: string; firstName: string },
    profileId: string,
    reason: string,
    loginCode: string | null,
  ): Promise<void> {
    const params = { firstName: result.firstName, reason, loginCode };

    if (!this.dispatcher) {
      await this.whatsApp.sendTemplateMessage(
        result.phone,
        'kycRejected',
        params,
        profileId,
      );
      return;
    }

    await this.dispatcher.send({
      phone: result.phone,
      profileId,
      template: { key: 'kycRejected', params },
      freeForm: kycRejectedFreeForm({
        firstName: result.firstName,
        reason: reason?.trim() || 'Non précisé',
      }),
    });
  }

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
    const archived = await this.profileService.archivedAt(dto.ids);
    const result = await this.archiveService.restore('profiles', dto.ids);
    // Their sessions work again once restored (#878).
    await this.profileService.clearArchivedSessions(dto.ids);
    // And the offers archived with them come back (#870).
    this.profileService.announceRestored(archived);
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
      'Irreversible. Refuses a profile that made or attempted a payment, returning 409 with the blocking counts. Otherwise deletes the profile with everything linked to it, then removes its files (KYC, avatar, portfolio, attachments) from storage.',
  })
  @ApiResponse({ status: 201, description: 'Rows permanently deleted' })
  @ApiResponse({ status: 409, description: 'Blocked by linked records' })
  async bulkPurge(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const profileFiles = this.profileFiles;
    const result = await this.archiveService.purge('profiles', dto.ids, {
      // Listed inside the purge transaction, so it matches what is deleted.
      collect: profileFiles
        ? (tx, ids) => profileFiles.collect(tx, ids)
        : undefined,
    });
    // Only once the rows are gone: a refused or failed purge touches no file.
    const files = profileFiles
      ? await profileFiles.remove(result.collected ?? [])
      : { deleted: 0, failed: 0 };
    await this.logService.create({
      action: 'PROFILE_BULK_PURGED',
      entityType: 'Profile',
      userId: req.user?.userId,
      metadata: {
        ids: dto.ids,
        count: result.count,
        filesDeleted: files.deleted,
        filesFailed: files.failed,
      },
      ...extractRequestMeta(req),
    });
    return { count: result.count };
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

  /**
   * The bytes of one KYC document, streamed behind the admin session.
   *
   * This replaces handing the browser a signed url. A signed url is a bearer
   * credential: it works for anyone who copies it out of the network panel, it
   * lingers in history, and it goes stale while the tab sits open — which is
   * how an identity document turned into a broken image an hour after upload.
   * Here the url never exists, and the check happens on every single request.
   *
   * `no-store` because the alternative is an identity document sitting in an
   * admin's disk cache after they log out.
   */
  @Get(':id/kyc-documents/:documentId/raw')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Stream a KYC document (admin only)',
    description:
      'Returns the raw bytes, authenticated by the admin session. No url is ' +
      'ever issued for the underlying object.',
  })
  @ApiResponse({ status: 200, description: 'The file bytes' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 404,
    description: 'No such document on this profile, or the file is gone',
  })
  async streamKycDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.profileService.streamKycDocument(id, documentId);
    this.sendKycFile(res, file);
  }

  /** The organisation behind a business profile: details, documents, gaps. */
  @Get(':id/business')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Business of a business profile (admin only)' })
  @ApiResponse({ status: 200, description: 'The business and its documents' })
  @ApiResponse({ status: 404, description: 'Not a business profile' })
  getBusiness(@Param('id') id: string) {
    return this.profileService.getBusinessForAdmin(id);
  }

  /** A business document's bytes, behind the admin session (as KYC). */
  @Get(':id/business/documents/:documentId/raw')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Stream a business document (admin only)' })
  @ApiResponse({ status: 200, description: 'The file bytes' })
  @ApiResponse({
    status: 404,
    description: 'No such document on this business',
  })
  async streamBusinessDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.profileService.streamBusinessDocument(
      id,
      documentId,
    );
    this.sendKycFile(res, file);
  }

  @Patch(':id/business/documents/:documentId/verify')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Accept or refuse one business document (admin only)',
  })
  async verifyBusinessDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Body() dto: AdminVerifyBusinessDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const adminUserId = req.user?.userId ?? 'system';
    const result = await this.profileService.verifyBusinessDocument(
      id,
      documentId,
      adminUserId,
      dto.decision,
      dto.reason,
    );
    await this.logService.create({
      action:
        dto.decision === VerifyDecision.VERIFIED
          ? 'BUSINESS_DOCUMENT_APPROVED'
          : 'BUSINESS_DOCUMENT_REJECTED',
      entityType: 'BusinessDocument',
      entityId: documentId,
      userId: adminUserId,
      profileId: id,
      metadata: { decision: dto.decision, reason: dto.reason },
    });

    // A refused paper is the business's to replace: tell it, by email and
    // in-app (never WhatsApp). An accepted one waits for the overall decision.
    if (dto.decision === VerifyDecision.REJECTED) {
      const doc = result.documents.find((d) => d.id === documentId);
      if (doc)
        await this.notifyBusinessDocumentRejected(
          id,
          result.name,
          doc.label,
          dto.reason,
        );
    }
    return result;
  }

  /** Corrects an organisation's details; an admin's edit reopens no review. */
  @Patch(':id/business')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Edit the business of a business profile (admin only)',
  })
  @ApiResponse({ status: 200, description: 'The business after the edit' })
  async updateBusiness(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const { business } = await this.profileService.updateBusiness(
      id,
      dto,
      'admin',
    );
    await this.logService.create({
      action: 'BUSINESS_UPDATED',
      entityType: 'Business',
      entityId: business.id,
      userId: req.user?.userId ?? 'system',
      profileId: id,
      metadata: { fields: Object.keys(dto) },
    });
    return business;
  }

  private async notifyBusinessDocumentRejected(
    profileId: string,
    businessName: string,
    documentLabel: string,
    reason?: string,
  ): Promise<void> {
    notifyProfile(this.events, {
      recipientId: profileId,
      input: {
        type: 'BUSINESS_DOCUMENT_REJECTED',
        documentLabel,
        reason: reason ?? null,
      },
    });
    const person = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { first_name: true, last_name: true, email: true },
    });
    if (!person?.email) return;
    const name = `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim();
    await this.mail
      .sendMail({
        to: person.email,
        subject: `${documentLabel} : document à remplacer`,
        html: await this.layout.wrap(
          businessDocumentRejectedEmail(
            name,
            businessName,
            documentLabel,
            reason,
            businessOrganisationUrl(),
          ),
          { product: 'business' },
        ),
      })
      .catch((err: unknown) =>
        console.warn(
          `Failed to send the business document email for ${profileId}:`,
          err,
        ),
      );
  }

  /**
   * The decision on the business itself, which verifies (and activates) the
   * account or refuses it. Told by email and in-app only: business accounts
   * get no WhatsApp.
   */
  @Patch(':id/business/verify')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Approve or refuse a business (admin only)' })
  @ApiResponse({ status: 200, description: 'The business after the decision' })
  async verifyBusiness(
    @Param('id') id: string,
    @Body() dto: AdminVerifyBusinessDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const adminUserId = req.user?.userId ?? 'system';
    const result = await this.profileService.verifyBusiness(
      id,
      adminUserId,
      dto.decision,
      dto.reason,
    );
    await this.logService.create({
      action:
        dto.decision === VerifyDecision.VERIFIED
          ? 'BUSINESS_APPROVED'
          : 'BUSINESS_REJECTED',
      entityType: 'Business',
      entityId: result.id,
      userId: adminUserId,
      profileId: id,
      metadata: { decision: dto.decision, reason: dto.reason },
    });

    const person = await this.prisma.profile.findUnique({
      where: { id },
      select: { first_name: true, last_name: true, email: true },
    });
    const name =
      `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim();
    const to = person?.email ?? result.email;
    const approved = dto.decision === VerifyDecision.VERIFIED;

    notifyProfile(this.events, {
      recipientId: id,
      input: approved
        ? { type: 'BUSINESS_VERIFIED', businessName: result.name }
        : {
            type: 'BUSINESS_REJECTED',
            businessName: result.name,
            reason: dto.reason ?? null,
          },
    });
    if (to) {
      await this.mail
        .sendMail({
          to,
          subject: approved
            ? `${result.name} est vérifiée sur Rabotka Business`
            : `Vérification de ${result.name} : dossier à corriger`,
          html: await this.layout.wrap(
            approved
              ? businessApprovedEmail(name, result.name, businessDashboardUrl())
              : businessRejectedEmail(
                  name,
                  result.name,
                  dto.reason,
                  businessOrganisationUrl(),
                ),
            { product: 'business' },
          ),
        })
        .catch((err: unknown) =>
          console.warn(
            `Failed to send the business decision email for ${id}:`,
            err,
          ),
        );
    }

    return result;
  }

  @Get(':id/verification-images/:imageId/raw')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Stream a KYC verification image (admin only)',
    description: 'As above, for an image attached during review.',
  })
  @ApiResponse({ status: 200, description: 'The file bytes' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 404,
    description: 'No such image on this profile, or the file is gone',
  })
  async streamVerificationImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.profileService.streamVerificationImage(id, imageId);
    this.sendKycFile(res, file);
  }

  private sendKycFile(
    res: Response,
    file: {
      body: NodeJS.ReadableStream;
      contentType?: string;
      contentLength?: number;
      filename: string;
    },
  ): void {
    res.setHeader(
      'Content-Type',
      file.contentType || 'application/octet-stream',
    );
    if (file.contentLength !== undefined) {
      res.setHeader('Content-Length', String(file.contentLength));
    }
    // `inline` so the admin's <img> renders it rather than downloading it; the
    // filename is only there for when a reviewer does save a copy.
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    // The bytes are a photograph of somebody's ID; nothing should be sniffing
    // them into a different content type and rendering them as a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    file.body.pipe(res);
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

  /**
   * What the assistant remembers about someone, and the lever to erase it.
   *
   * VoVa keeps a short list of durable facts per profile and puts it in every
   * prompt for up to ninety days. That is generated text about a real person,
   * standing between them and every answer they get — so it has to be readable
   * by a human and clearable by one. Without this the only remedy for a wrong
   * or unwelcome fact is a hand-written UPDATE against production.
   *
   * Prisma is used directly rather than `VovaMemoryService`: reading the row is
   * a primary-key lookup, and going through the service would make the profile
   * module depend on the whole RAG module for two endpoints.
   */
  @Get(':id/vova-memory')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Read what the assistant remembers about a profile (admin only)',
    description:
      'The durable facts VoVa carries between conversations. Returns an empty list when nothing has been remembered yet, which is the ordinary state.',
  })
  @ApiResponse({ status: 200, description: 'The remembered facts' })
  async getVovaMemory(@Param('id') id: string) {
    const row = await this.prisma.vovaProfileMemory.findUnique({
      where: { profile_id: id },
      select: { facts: true, updated_at: true },
    });
    return { facts: row?.facts ?? [], updatedAt: row?.updated_at ?? null };
  }

  @Delete(':id/vova-memory')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: "Erase the assistant's memory of a profile (admin only)",
    description:
      'Deletes the row outright. The list rebuilds itself from later conversations, so this is a reset rather than a permanent block — and it is idempotent: erasing a memory that does not exist succeeds.',
  })
  @ApiResponse({ status: 200, description: 'Memory erased' })
  async deleteVovaMemory(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ success: true }> {
    // `deleteMany`, not `delete`: erasing a memory that was never written is
    // the expected case for most profiles and must not 404 at somebody trying
    // to honour a complaint.
    await this.prisma.vovaProfileMemory.deleteMany({
      where: { profile_id: id },
    });
    await this.logService.create({
      action: 'PROFILE_VOVA_MEMORY_ERASED',
      entityType: 'Profile',
      entityId: id,
      // Also keyed on the profile, so the erasure shows up in that person's own
      // timeline — where anyone handling their complaint will look for it.
      profileId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { success: true };
  }

  @Get(':id/payment-requests')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get payment requests for a profile (admin only)' })
  async getPaymentRequests(@Param('id') id: string) {
    return await this.paymentRequestService.getByProfileId(id);
  }

  @Get(':id/contacts')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Paid contacts for a profile (admin only)',
    description:
      'Both directions: `contacted` is everyone this employer paid to reach, `contactedBy` is every employer who paid to reach this worker. Same table as `admin/contact-records`, so the tab and the list cannot disagree.',
  })
  async getContacts(@Param('id') id: string) {
    return this.adminContactRecords.forProfile(id);
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
      'MANUAL_CREDIT',
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

    // An admin who is mid-handover keeps the bot quiet by talking. Only
    // EXTENDS an existing pause — sending a message is not itself a request to
    // silence the bot, and an admin who never touched the toggle has not asked
    // for one.
    await this.botPause?.refresh(id);

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

  /**
   * Take the conversation over: VoVa says nothing to this profile.
   *
   * Scoped to ONE profile on purpose. The switch in Settings turns the
   * assistant off for everybody; this is an admin answering one person and
   * not wanting a robot talking over them while they do it.
   *
   * It suppresses the bot's replies AND anything scheduled — a mission
   * reminder landing mid-handover is exactly the interruption this prevents.
   * The admin's own messages are unaffected: they never go through the
   * notification dispatcher.
   *
   * Idempotent, and calling it again pushes the deadline out.
   */
  @Post(':id/bot-pause')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Pause the bot for this profile (admin only)' })
  async pauseBot(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const until = await this.botPause!.pause(id);
    await this.logService.create({
      action: 'PROFILE_BOT_PAUSED',
      entityType: 'PROFILE',
      entityId: id,
      userId: req.user?.userId,
      metadata: { until: until.toISOString() },
      ...extractRequestMeta(req),
    });
    return { botPausedUntil: until };
  }

  /** Hand the conversation back to the bot, before the pause lapses on its own. */
  @Delete(':id/bot-pause')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Resume the bot for this profile (admin only)' })
  async resumeBot(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    await this.botPause!.resume(id);
    await this.logService.create({
      action: 'PROFILE_BOT_RESUMED',
      entityType: 'PROFILE',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { botPausedUntil: null };
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
  @UseInterceptors(FileInterceptor('avatar', imageMulterOptions()))
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

  /**
   * Upload ONE supporting image for a KYC review, ahead of the verify call.
   *
   * `PATCH :id/verify` used to carry the bytes itself, as up to ten binary
   * parts. That made the whole review all-or-nothing on submit, with no
   * progress and no way to retry a single failed photograph — and the route
   * carried neither a size limit nor a mime filter.
   *
   * MANAGER, matching `:id/verify` exactly. A role that could upload here but
   * not verify would be able to write objects into the private KYC bucket with
   * no way to attach them, which is a write with no audit trail.
   *
   * Images only — no PDF, unlike the onboarding `POST /profile/kyc-upload`.
   * The admin dropzone accepts jpeg/png/webp and compresses to JPEG before
   * sending, so a PDF here would be a shape the UI cannot produce.
   */
  @Post(':id/verification-images')
  @Roles(UserRole.MANAGER)
  @UseInterceptors(
    FileInterceptor('file', imageMulterOptions(10 * 1024 * 1024)),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload one KYC verification image (admin only)',
    description:
      'Stores the image in the private KYC bucket and returns its descriptor. ' +
      'Pass the returned `key` to PATCH :id/verify. `key` is the durable half; ' +
      '`url` is a signed preview that expires within the hour — never persist it.',
  })
  @ApiResponse({
    status: 201,
    description: 'Image stored; key and url returned',
  })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async uploadVerificationImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ key: string; url: string }> {
    if (!file) throw new BadRequestException("L'image est requise");
    return this.profileService.uploadVerificationImage(id, file);
  }

  @Patch(':id/verify')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Verify or reject profile KYC (admin only)',
    description:
      'Approves or rejects KYC verification for a profile and its documents. ' +
      'Supporting images must be uploaded first via POST :id/verification-images; ' +
      'this call carries only their keys.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verify(
    @Param('id') id: string,
    @Body() dto: AdminVerifyProfileDto,
    @Req() req: any,
  ) {
    // A business has no personal KYC: its review is the Business tab, and the
    // KYC emails (« vérification d'identité… ouvrez l'application ») and the
    // WhatsApp agreement send are not written for it.
    const target = await this.prisma.profile.findUnique({
      where: { id },
      select: { is_business: true },
    });
    if (target?.is_business) {
      throw new BadRequestException(
        "Un compte entreprise se vérifie depuis l'onglet Business.",
      );
    }
    const adminUserId = req.user?.userId ?? 'system';
    const result = await this.profileService.verifyProfileKyc(
      id,
      adminUserId as string,
      dto.decision,
      dto.reason,
      dto.documents,
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
        // The count, never the descriptors: a document's `url` is a live signed
        // credential, and the audit log is not the place for one.
        documentCount: dto.documents?.length ?? 0,
      },
    });

    const fullName = `${result.firstName} ${result.lastName}`.trim();

    if (dto.decision === VerifyDecision.VERIFIED) {
      await this.mail.sendMail({
        to: result.email,
        subject: 'Votre vérification KYC a été approuvée',
        html: await this.layout.wrap(kycApprovedEmail(fullName)),
      });

      // Free inside the 24h window, the template outside it.
      (this.dispatcher
        ? this.dispatcher.send({
            phone: result.phone,
            profileId: id,
            template: { key: 'kyc', params: result.firstName },
            freeForm: kycApprovedFreeForm(result.firstName),
          })
        : this.whatsApp.sendTemplateMessage(
            result.phone,
            'kyc',
            result.firstName,
            id,
          )
      ).catch((err: unknown) =>
        console.warn(
          `Failed to send KYC validated WhatsApp message for ${id}:`,
          err,
        ),
      );

      // The agreement, as a second message and deliberately after the one
      // above. The `kyc` template carries the CTA that gets the user back into
      // the app; putting a PDF render, an upload and a Graph fetch in front of
      // it would delay the message this approval exists to send.
      //
      // Not awaited, like the notification: the verification response must not
      // wait on any of that, and `sendAgreementDocument` never rejects.
      void this.profileService
        .sendAgreementDocument(id)
        .catch((err) =>
          console.warn(
            `Failed to send the KYC agreement document for ${id}:`,
            err,
          ),
        );
    } else {
      notifyProfile(this.events, {
        recipientId: id,
        input: { type: 'KYC_REJECTED', reason: dto.reason ?? null },
      });
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

      this.notifyRejection(result, id, dto.reason, loginCode).catch(
        (err: unknown) =>
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
