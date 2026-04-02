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
import { ClaimService } from './claim.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateClaimDto } from './dto/update-claim.dto';
import { AdminListClaimsDto } from './dto/admin-list-claims.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { LogService } from '../log/log.service';

@Controller('admin/claims')
@UseGuards(AdminAuthGuard)
export class ClaimController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly logService: LogService,
  ) {}

  @Post()
  async create(@Req() req: any, @Body() dto: CreateClaimDto) {
    const result = await this.claimService.createForAdmin(req.user.userId, dto);
    await this.logService.create({
      action: 'CLAIM_CREATED',
      entityType: 'Claim',
      entityId: (result as any)?.id,
      userId: req.user.userId,
      metadata: { title: dto.title },
    });
    return result;
  }

  @Get()
  list(@Query() dto: AdminListClaimsDto) {
    return this.claimService.listForAdmin(dto);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.claimService.getByIdForAdmin(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateClaimDto, @Req() req: any) {
    const result = await this.claimService.updateForAdmin(id, dto);
    await this.logService.create({
      action: 'CLAIM_UPDATED',
      entityType: 'Claim',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: dto },
    });
    return result;
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Req() req: any) {
    await this.claimService.deleteForAdmin(id);
    await this.logService.create({
      action: 'CLAIM_DELETED',
      entityType: 'Claim',
      entityId: id,
      userId: req.user?.userId,
    });
    return { success: true };
  }
}

@Controller('admin/claims/:claimId/comments')
@UseGuards(AdminAuthGuard)
export class ClaimCommentController {
  constructor(
    private readonly claimService: ClaimService,
    private readonly logService: LogService,
  ) {}

  @Get()
  list(@Param('claimId') claimId: string) {
    return this.claimService.listComments(claimId);
  }

  @Post()
  async add(@Param('claimId') claimId: string, @Req() req: any, @Body() dto: CreateCommentDto) {
    const result = await this.claimService.addComment(claimId, req.user.userId, dto);
    await this.logService.create({
      action: 'CLAIM_COMMENT_ADDED',
      entityType: 'Claim',
      entityId: claimId,
      userId: req.user.userId,
    });
    return result;
  }

  @Delete(':commentId')
  async remove(@Param('claimId') claimId: string, @Param('commentId') commentId: string, @Req() req: any) {
    await this.claimService.deleteComment(claimId, commentId);
    await this.logService.create({
      action: 'CLAIM_COMMENT_DELETED',
      entityType: 'Claim',
      entityId: claimId,
      userId: req.user?.userId,
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
    return this.claimService.listCommentsForProfile(claimId, req.user.profileId);
  }

  @Post()
  add(@Param('claimId') claimId: string, @Req() req: any, @Body() dto: CreateCommentDto) {
    return this.claimService.addCommentAsProfile(claimId, req.user.profileId, dto);
  }

  @Delete(':commentId')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('claimId') claimId: string, @Param('commentId') commentId: string, @Req() req: any) {
    await this.claimService.deleteCommentAsProfile(claimId, commentId, req.user.profileId);
    return { success: true };
  }
}
