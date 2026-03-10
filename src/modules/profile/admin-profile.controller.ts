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
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
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
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { PaymentRequestService } from '../payment-request/payment-request.service';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { MailService } from '../mail/mail.service';
import { MessageDirection, BotPlatform } from '@prisma/client';
import { AdminListProfilesDto } from './dto/admin-list-profiles.dto';
import {
  AdminVerifyProfileDto,
  VerifyDecision,
} from './dto/admin-verify-profile.dto';
import { AdminUpdateStatusDto } from './dto/admin-update-status.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@ApiTags('Admin – Profiles')
@Controller('admin/profiles')
@UseGuards(AdminAuthGuard)
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
  ) {}

  @Get()
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
  @ApiOperation({
    summary: 'Get profile audit logs (admin only)',
    description: 'Returns the audit trail / timeline for a profile.',
  })
  @ApiResponse({ status: 200, description: 'List of log entries' })
  async getLogs(@Param('id') id: string) {
    return await this.logService.getByProfileId(id);
  }

  @Get(':id/payment-requests')
  @ApiOperation({ summary: 'Get payment requests for a profile (admin only)' })
  async getPaymentRequests(@Param('id') id: string) {
    return await this.paymentRequestService.getByProfileId(id);
  }

  @Get(':id/messages')
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
  @ApiOperation({ summary: 'Send a message to a profile (admin only)' })
  async sendMessage(
    @Param('id') id: string,
    @Body() body: { channel: 'WHATSAPP' | 'EMAIL'; message: string },
    @Req() req: any,
  ) {
    const adminUserId: string | undefined = req.user?.userId;
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: { id: true, phone: true, email: true, first_name: true },
    });

    if (!profile) {
      throw new NotFoundException('profile.errors.not_found');
    }

    if (!body.message?.trim()) {
      throw new BadRequestException('Message cannot be empty.');
    }

    if (body.channel === 'WHATSAPP') {
      if (!profile.phone) {
        throw new BadRequestException('Profile has no phone number.');
      }
      await this.whatsApp.sendTextMessage(
        profile.phone,
        body.message.trim(),
        profile.id,
        adminUserId,
      );
    } else {
      if (!profile.email) {
        throw new BadRequestException('Profile has no email address.');
      }
      await this.mail.sendMail({
        to: profile.email,
        subject: 'Message de Rabotka',
        html: `<p>${body.message.trim().replace(/\n/g, '<br/>')}</p>`,
      });
      // Save outbound email message to history
      await this.prisma.message.create({
        data: {
          profile_id: profile.id,
          direction: MessageDirection.OUTBOUND,
          platform: BotPlatform.EMAIL,
          body: body.message.trim(),
          ...(adminUserId ? { sent_by_id: adminUserId } : {}),
        },
      });
    }

    return { success: true };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update profile fields (admin only)',
    description: 'Updates profile fields like name, description, address.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
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

  @Patch(':id/verify')
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
      adminUserId,
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
        ...(dto.reason ? { reason: dto.reason } : {}),
      },
    });
    return result;
  }

  @Patch(':id/status')
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
      action: 'STATUS_CHANGED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: {
        newStatus: dto.status,
        ...(dto.reason ? { reason: dto.reason } : {}),
      },
    });
    return result;
  }

  @Patch(':id/confirm-payment')
  @ApiOperation({
    summary: 'Confirm payment for a profile (admin only)',
    description: 'Manually confirms payment and activates the profile.',
  })
  @ApiResponse({ status: 200, description: 'Updated profile details' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async confirmPayment(@Param('id') id: string, @Req() req: any) {
    const result = await this.profileService.updateProfileStatusByAdmin(
      id,
      'ACTIVE' as any,
    );
    const adminUserId = req.user?.userId;
    await this.logService.create({
      action: 'PAYMENT_CONFIRMED',
      entityType: 'Profile',
      entityId: id,
      userId: adminUserId,
      profileId: id,
      metadata: { note: 'Payment manually confirmed by admin' },
    });
    return result;
  }
}
