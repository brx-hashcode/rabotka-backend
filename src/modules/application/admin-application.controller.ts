import {
  Body,
  Controller,
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
import { ApplicationService } from './application.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminListApplicationsDto } from './dto/admin-list-applications.dto';
import { BulkDeleteDto } from '../../common/dto/bulk-delete.dto';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

@ApiTags('Admin – Applications')
@Controller('admin/applications')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MODERATOR)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminApplicationController {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly logService: LogService,
  ) {}

  @Post('bulk-delete')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Bulk archive applications (admin only)',
    description: 'Soft-deletes (archives) the given applications.',
  })
  @ApiResponse({ status: 201, description: 'Applications archived' })
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<{ count: number }> {
    const result = await this.applicationService.bulkSoftDeleteApplications(
      dto.ids,
    );
    await this.logService.create({
      action: 'APPLICATION_BULK_DELETED',
      entityType: 'Application',
      userId: req.user?.userId,
      metadata: { ids: dto.ids, count: result.count },
      ...extractRequestMeta(req),
    });
    return result;
  }

  @Get()
  @ApiOperation({
    summary: 'List applications (admin only)',
    description:
      'Returns paginated applications with optional search and filters: status, penalty_applied.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of applications' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async list(@Query() dto: AdminListApplicationsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    return this.applicationService.getApplicationsForAdmin({
      page,
      limit,
      q: dto.q,
      status: dto.status,
      penaltyApplied: dto.penalty_applied,
      workerId: dto.worker_id,
      employerId: dto.employer_id,
      deleted: dto.deleted,
    });
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get application details (admin only)',
    description:
      'Returns full application details including worker, employer, job, and penalties.',
  })
  @ApiResponse({ status: 200, description: 'Application details' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getById(@Param('id') id: string) {
    return this.applicationService.getApplicationDetailForAdmin(id);
  }
}
