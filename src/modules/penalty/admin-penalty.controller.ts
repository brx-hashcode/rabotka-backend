import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PenaltyService } from './penalty.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminListPenaltiesDto } from './dto/admin-list-penalties.dto';
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { LogService } from '../log/log.service';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Admin - Penalties')
@Controller('admin/penalties')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminPenaltyController {
  constructor(
    private readonly penaltyService: PenaltyService,
    private readonly logService: LogService,
    private readonly archiveService: ArchiveService,
  ) {}

  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Create a penalty manually (admin only)' })
  @ApiResponse({ status: 201, description: 'Penalty created' })
  async createPenalty(
    @Body()
    body: {
      profileId: string;
      applicationId?: string;
      amount: number;
      reason: string;
    },
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.penaltyService.createPenaltyByAdmin({
      ...body,
      adminUserId: req.user.userId,
    });
    await this.logService.create({
      action: 'PENALTY_CREATED',
      entityType: 'Penalty',
      entityId: (result as { id?: string })?.id,
      userId: req.user.userId,
      profileId: body.profileId,
      metadata: {
        amount: body.amount,
        reason: body.reason,
        applicationId: body.applicationId ?? null,
      },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List penalties (admin only)',
    description:
      'Returns paginated penalties with optional search and filters: payment_status.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of penalties' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListPenaltiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return await this.penaltyService.getPenaltiesForAdmin({
      page,
      limit,
      q: dto.q,
      paymentStatus: dto.payment_status,
      deleted: dto.deleted,
    });
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get penalty details (admin only)',
    description:
      'Returns full penalty details including worker, application, and job info.',
  })
  @ApiResponse({ status: 200, description: 'Penalty details' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async getById(@Param('id') id: string) {
    return await this.penaltyService.getPenaltyDetailForAdmin(id);
  }

  @Post(':id/confirm-payment')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Manually confirm penalty payment (admin only)',
    description:
      'Records the penalty as paid, credits the system wallet, and updates the worker billing status.',
  })
  @ApiResponse({ status: 201, description: 'Penalty payment confirmed' })
  @ApiResponse({ status: 400, description: 'Penalty already paid' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async confirmPayment(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.penaltyService.confirmPenaltyPaymentByAdmin(
      id,
      req.user.userId,
    );
    await this.logService.create({
      action: 'PENALTY_PAYMENT_CONFIRMED',
      entityType: 'Penalty',
      entityId: id,
      userId: req.user.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-restore')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk restore archived rows (admin only)',
    description: 'Clears deleted_at. Only rows that are currently archived are affected.',
  })
  @ApiResponse({ status: 201, description: 'Rows restored' })
  async bulkRestore(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.archiveService.restore('penalties', dto.ids);
    await this.logService.create({
      action: 'PENALTY_BULK_RESTORED',
      entityType: 'Penalty',
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
    const result = await this.archiveService.purge('penalties', dto.ids);
    await this.logService.create({
      action: 'PENALTY_BULK_PURGED',
      entityType: 'Penalty',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-delete')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk archive penalties (admin only)',
    description:
      'Soft-deletes (archives) the given penalties (skips already-paid ones) and re-syncs billing status.',
  })
  @ApiResponse({ status: 201, description: 'Penalties archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.penaltyService.bulkSoftDeletePenalties(dto.ids);
    await this.logService.create({
      action: 'PENALTY_BULK_DELETED',
      entityType: 'Penalty',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Delete a penalty (admin only)',
    description:
      'Archives a penalty (soft delete) and re-syncs the worker billing status.',
  })
  @ApiResponse({ status: 200, description: 'Penalty deleted' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async deletePenalty(
    @Param('id') id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.penaltyService.deletePenalty(id);
    await this.logService.create({
      action: 'PENALTY_DELETED',
      entityType: 'Penalty',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return result;
  }
}
