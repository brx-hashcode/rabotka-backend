import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ClaimService } from './claim.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
import { AdminListClaimsDto } from './dto/admin-list-claims.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { LogService } from '../log/log.service';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@Controller('admin/claims')
@UseGuards(AdminAuthGuard, RolesGuard)
export class ClaimController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly logService: LogService,
  ) {}

  @Post()
  @Roles(UserRole.MANAGER)
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateClaimDto,
  ) {
    const result = await this.claimService.createForAdmin(req.user.userId, dto);
    await this.logService.create({
      action: 'CLAIM_CREATED',
      entityType: 'Claim',
      entityId: (result as { id?: string })?.id,
      userId: req.user.userId,
      metadata: { title: dto.title },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get()
  @Roles(UserRole.MODERATOR)
  list(@Query() dto: AdminListClaimsDto) {
    return this.claimService.listForAdmin(dto);
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  getById(@Param('id') id: string) {
    return this.claimService.getByIdForAdmin(id);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateClaimDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.claimService.updateForAdmin(id, dto);
    await this.logService.create({
      action: 'CLAIM_UPDATED',
      entityType: 'Claim',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: { ...dto } },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  async delete(@Param('id') id: string, @Req() req: AdminAuthenticatedRequest) {
    await this.claimService.deleteForAdmin(id);
    await this.logService.create({
      action: 'CLAIM_DELETED',
      entityType: 'Claim',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { success: true };
  }
}

@Controller('admin/claims/:claimId/comments')
@UseGuards(AdminAuthGuard, RolesGuard)
export class ClaimCommentController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly logService: LogService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  list(@Param('claimId') claimId: string) {
    return this.claimService.listComments(claimId);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  async add(
    @Param('claimId') claimId: string,
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateCommentDto,
  ) {
    const result = await this.claimService.addComment(
      claimId,
      req.user.userId,
      dto,
    );
    await this.logService.create({
      action: 'CLAIM_COMMENT_ADDED',
      entityType: 'Claim',
      entityId: claimId,
      userId: req.user.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':commentId')
  @Roles(UserRole.MANAGER)
  async remove(
    @Param('claimId') claimId: string,
    @Param('commentId') commentId: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    await this.claimService.deleteComment(claimId, commentId);
    await this.logService.create({
      action: 'CLAIM_COMMENT_DELETED',
      entityType: 'Claim',
      entityId: claimId,
      userId: req.user?.userId,
      metadata: { commentId },
      ...extractRequestMeta(req),
    });
    return { success: true };
  }
}

@Controller('profile/claims')
@UseGuards(ProfileAuthGuard)
export class ProfileClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateClaimDto) {
    return this.claimService.createForProfile(req.user.profileId, dto);
  }

  @Get()
  list(@Req() req: any) {
    return this.claimService.listForProfile(req.user.profileId);
  }

  @Get(':id')
  getById(@Param('id') id: string, @Req() req: any) {
    return this.claimService.getByIdForProfile(id, req.user.profileId);
  }
}

@Controller('profile/claims/:claimId/comments')
@UseGuards(ProfileAuthGuard)
export class ProfileClaimCommentController {
  constructor(private readonly claimService: ClaimService) {}

  @Get()
  list(@Param('claimId') claimId: string, @Req() req: any) {
    return this.claimService.listCommentsForProfile(
      claimId,
      req.user.profileId,
    );
  }

  @Post()
  add(
    @Param('claimId') claimId: string,
    @Req() req: any,
    @Body() dto: CreateCommentDto,
  ) {
    return this.claimService.addCommentAsProfile(
      claimId,
      req.user.profileId,
      dto,
    );
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('claimId') claimId: string,
    @Param('commentId') commentId: string,
    @Req() req: any,
  ) {
    await this.claimService.deleteCommentAsProfile(
      claimId,
      commentId,
      req.user.profileId,
    );
    return { success: true };
  }
}
