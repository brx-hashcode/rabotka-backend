import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { DashboardService } from './dashboard.service';
import { JobActivityQueryDto, TimeRange } from './dto/job-activity-query.dto';

@ApiTags('Admin – Dashboard')
@Controller('admin/dashboard')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminDashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

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
