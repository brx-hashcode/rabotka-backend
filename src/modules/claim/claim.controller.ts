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

@Controller('admin/claims')
@UseGuards(AdminAuthGuard)
export class ClaimController {
  constructor(private readonly claimService: ClaimService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateClaimDto) {
    return this.claimService.createForAdmin(req.user.userId, dto);
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
  update(@Param('id') id: string, @Body() dto: UpdateClaimDto) {
    return this.claimService.updateForAdmin(id, dto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    await this.claimService.deleteForAdmin(id);
    return { success: true };
  }
}

@Controller('admin/claims/:claimId/comments')
@UseGuards(AdminAuthGuard)
export class ClaimCommentController {
  constructor(private readonly claimService: ClaimService) {}

  @Get()
  list(@Param('claimId') claimId: string) {
    return this.claimService.listComments(claimId);
  }

  @Post()
  add(@Param('claimId') claimId: string, @Req() req: any, @Body() dto: CreateCommentDto) {
    return this.claimService.addComment(claimId, req.user.userId, dto);
  }

  @Delete(':commentId')
  async remove(@Param('claimId') claimId: string, @Param('commentId') commentId: string) {
    await this.claimService.deleteComment(claimId, commentId);
    return { success: true };
  }
}
