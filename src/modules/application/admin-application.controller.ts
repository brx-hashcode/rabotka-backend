import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { ApplicationService } from './application.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListApplicationsDto } from './dto/admin-list-applications.dto';

@ApiTags('Admin – Applications')
@Controller('admin/applications')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminApplicationController {
  constructor(private readonly applicationService: ApplicationService) {}

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
    });
  }
}
