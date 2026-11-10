import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';
import { STATS_PERIODS } from '../business-stats';
import { AdminBusinessService, MAX_ADMIN_NOTE } from './admin-business.service';

class ActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsUUID()
  memberId?: string;
}

class AdminNoteDto {
  @IsString()
  @MaxLength(MAX_ADMIN_NOTE)
  body!: string;
}

class DistributionDto {
  @IsBoolean()
  distributeOffers!: boolean;
}

class AdminPartnerDto {
  @IsBoolean()
  partner!: boolean;

  /** Its place among partners, 1 first; none puts it after the numbered ones. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  rank?: number | null;
}

/**
 * A business profile in rabotka-admin: what the business works with, and the
 * fixes support may make. Reading is for moderators, acting for managers;
 * every action goes to the admin log.
 */
@ApiTags('Admin – Businesses')
@Controller('admin/profiles/:id/business')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminBusinessController {
  constructor(
    private readonly business: AdminBusinessService,
    private readonly logs: LogService,
  ) {}

  // ── Reading ──────────────────────────────────────────────────────────

  @Get('overview')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: "The business dashboard's figures (days: 7, 30, 90)",
  })
  overview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('days') days?: string,
  ) {
    const period = STATS_PERIODS.find((d) => String(d) === days) ?? 30;
    return this.business.overview(id, period);
  }

  @Get('usage')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'What the plan allows and what is used' })
  usage(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.usage(id);
  }

  @Get('team')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Members (removed ones too) and places per role' })
  team(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.teamOf(id);
  }

  @Get('activity')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "The business's activity log, newest first" })
  activity(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ActivityQueryDto,
  ) {
    return this.business.activity(id, query);
  }

  @Get('careers')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Careers page: link, distribution, media' })
  careers(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.careersOf(id);
  }

  @Get('mailboxes')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Connected mailboxes (no tokens)' })
  mailboxes(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.mailboxesOf(id);
  }

  @Get('health')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'At a glance: plan, what is stuck, last activity, figures',
  })
  health(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.health(id);
  }

  @Get('interviews')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "Its interviews and the candidates' answers" })
  interviews(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.interviews(id);
  }

  @Get('cv-screenings')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Its CV analyses: CVs read, files kept until' })
  cvScreenings(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.cvScreenings(id);
  }

  // ── Admin notes (never shown to the business) ────────────────────────

  @Get('notes')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: "Rabotka's own follow-up notes on this business" })
  notes(@Param('id', ParseUUIDPipe) id: string) {
    return this.business.notes(id);
  }

  @Post('notes')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Add a follow-up note' })
  addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminNoteDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.business.addNote(id, req.user.userId, dto.body);
  }

  @Patch('notes/:noteId')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Edit one of my notes' })
  editNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: AdminNoteDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.business.editNote(id, req.user.userId, noteId, dto.body);
  }

  @Delete('notes/:noteId')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Delete one of my notes' })
  deleteNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.business.deleteNote(id, req.user.userId, noteId);
  }

  // ── Support actions ──────────────────────────────────────────────────

  @Post('team/:memberId/resend')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Send a team invitation again' })
  async resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const member = await this.business.resendInvite(id, memberId);
    await this.log(
      req,
      'BUSINESS_MEMBER_INVITE_RESENT',
      'BusinessMember',
      memberId,
      id,
      {
        email: member.email,
      },
    );
    return member;
  }

  @Delete('team/:memberId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Remove a team member: its sessions stop at once' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.business.removeMember(id, memberId);
    await this.log(
      req,
      'BUSINESS_MEMBER_REMOVED',
      'BusinessMember',
      memberId,
      id,
      {
        email: result.member.email,
        role: result.member.role,
      },
    );
    return { removed: true };
  }

  @Delete('mailboxes/:mailboxId')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: "Disconnect a mailbox and revoke the provider's access",
  })
  async disconnect(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mailboxId', ParseUUIDPipe) mailboxId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.business.disconnectMailbox(id, mailboxId);
    await this.log(
      req,
      'BUSINESS_MAILBOX_DISCONNECTED',
      'BusinessMailbox',
      mailboxId,
      id,
    );
    return result;
  }

  @Patch('careers/partner')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary:
      'Partner or not: « Ils recrutent avec Rabotka » and first on the careers site',
  })
  async setPartner(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminPartnerDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const page = await this.business.setPartner(id, {
      partner: dto.partner,
      rank: dto.rank,
    });
    await this.log(req, 'BUSINESS_PARTNER_SET', 'Business', id, id, {
      partner: dto.partner,
      rank: page.partnerRank,
    });
    return page;
  }

  @Delete('careers/photos/:index')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Remove a careers-page photo (moderation)' })
  async removePhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const before = await this.business.careersOf(id);
    const page = await this.business.removePhoto(id, index);
    await this.log(req, 'BUSINESS_CAREERS_MEDIA_REMOVED', 'Business', id, id, {
      kind: 'photo',
      url: before.photos[index] ?? null,
    });
    return page;
  }

  @Delete('careers/cover')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Remove the careers-page cover (moderation)' })
  async removeCover(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const before = await this.business.careersOf(id);
    const page = await this.business.removeCover(id);
    await this.log(req, 'BUSINESS_CAREERS_MEDIA_REMOVED', 'Business', id, id, {
      kind: 'cover',
      url: before.coverUrl,
    });
    return page;
  }

  @Patch('careers')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Turn distribution to Google and job sites on or off',
  })
  async distribution(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DistributionDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const page = await this.business.setDistribution(id, dto.distributeOffers);
    await this.log(req, 'BUSINESS_DISTRIBUTION_SET', 'Business', id, id, {
      distributeOffers: dto.distributeOffers,
    });
    return page;
  }

  private log(
    req: AdminAuthenticatedRequest,
    action: string,
    entityType: string,
    entityId: string,
    profileId: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.logs.create({
      action,
      entityType,
      entityId,
      userId: req.user?.userId ?? 'system',
      profileId,
      ...(metadata ? { metadata } : {}),
    });
  }
}
