import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';
import { JobActivityQueryDto, TimeRange } from './dto/job-activity-query.dto';

@ApiTags('Admin – Dashboard')
@Controller('admin/dashboard')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MODERATOR)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminDashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('metrics')
  @ApiOperation({
    summary: 'Get dashboard summary metrics (admin only)',
    description:
      'Returns total counts and 30-day trends for revenue, profiles, jobs, and applications.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard metrics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getMetrics() {
    return this.dashboardService.getMetrics();
  }

  @Get('job-status-distribution')
  @ApiOperation({
    summary: 'Get job status distribution (admin only)',
    description:
      'Returns job offer counts grouped by status for the given time range.',
  })
  @ApiResponse({ status: 200, description: 'Job status distribution' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getJobStatusDistribution(@Query() dto: JobActivityQueryDto) {
    return this.dashboardService.getJobStatusDistribution(
      dto.range ?? TimeRange.NINETY_DAYS,
    );
  }

  @Get('job-activity')
  @ApiOperation({
    summary: 'Get job activity chart data (admin only)',
    description:
      'Returns daily counts of jobs created and jobs filled for the given time range.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of daily job activity data points',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getJobActivity(@Query() dto: JobActivityQueryDto) {
    return this.dashboardService.getJobActivity(dto.range ?? TimeRange.NINETY_DAYS);
  }
}
