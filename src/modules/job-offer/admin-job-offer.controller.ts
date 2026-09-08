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
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ArchiveService } from '../admin-archive/archive.service';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { JobOfferService } from './job-offer.service';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminListJobOffersDto } from './dto/admin-list-job-offers.dto';
import { AdminUpdateJobOfferDto } from './dto/admin-update-job-offer.dto';
import { AdminUpdateJobOfferStatusDto } from './dto/admin-update-job-offer-status.dto';
import { LogService } from '../log/log.service';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Admin – Job Offers')
@Controller('admin/job-offers')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminJobOfferController {
  constructor(
    private readonly jobOfferService: JobOfferService,
    private readonly logService: LogService,
    private readonly archiveService: ArchiveService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List job offers (admin only)',
    description:
      'Returns paginated job offers with optional search and status filter.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of job offers' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListJobOffersDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return await this.jobOfferService.getJobOffersForAdmin({
      page,
      limit,
      q: dto.q,
      status: dto.status,
      employment_type: dto.employment_type,
      payment_flow: dto.payment_flow,
      amount_min: dto.amount_min,
      amount_max: dto.amount_max,
      deleted: dto.deleted,
    });
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Get job offer details (admin only)',
    description:
      'Returns full job offer details including employer info and applications list.',
  })
  @ApiResponse({ status: 200, description: 'Job offer details' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async getById(@Param('id') id: string) {
    return await this.jobOfferService.getJobOfferDetailForAdmin(id);
  }

  @Patch(':id/status')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update job offer status (admin only)',
    description: 'Updates the status of a job offer (e.g. ACTIVE, CANCELLED).',
  })
  @ApiResponse({ status: 200, description: 'Updated job offer' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: AdminUpdateJobOfferStatusDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.jobOfferService.updateStatusByAdmin(
      id,
      dto.status,
    );
    await this.logService.create({
      action: 'JOB_OFFER_STATUS_CHANGED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
      metadata: { status: dto.status },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Update job offer (admin only)',
    description:
      'Updates job offer fields like title, description, amount, etc.',
  })
  @ApiResponse({ status: 200, description: 'Updated job offer details' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: AdminUpdateJobOfferDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.jobOfferService.updateJobOfferByAdmin(id, dto);
    await this.logService.create({
      action: 'JOB_OFFER_UPDATED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: { ...dto } },
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
    const result = await this.archiveService.restore('jobs', dto.ids);
    await this.logService.create({
      action: 'JOB_OFFER_BULK_RESTORED',
      entityType: 'JobOffer',
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
    const result = await this.archiveService.purge('jobs', dto.ids);
    await this.logService.create({
      action: 'JOB_OFFER_BULK_PURGED',
      entityType: 'JobOffer',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Post('bulk-delete')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk archive job offers (admin only)',
    description: 'Soft-deletes (archives) the given job offers.',
  })
  @ApiResponse({ status: 201, description: 'Offers archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.jobOfferService.bulkSoftDeleteByAdmin(dto.ids);
    await this.logService.create({
      action: 'JOB_OFFER_BULK_DELETED',
      entityType: 'JobOffer',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete job offer (admin only)',
    description: 'Archives a job offer (soft delete).',
  })
  @ApiResponse({ status: 204, description: 'Job offer deleted' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async remove(@Param('id') id: string, @Req() req: AdminAuthenticatedRequest) {
    await this.jobOfferService.deleteJobOfferByAdmin(id);
    await this.logService.create({
      action: 'JOB_OFFER_DELETED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
  }
}
