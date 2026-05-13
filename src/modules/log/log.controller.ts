import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { LogService } from './log.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListLogsDto } from './dto/admin-list-logs.dto';

@ApiTags('Admin – Logs')
@Controller('log')
export class LogController {
  constructor(private readonly logService: LogService) {}

  @Get('admin')
  @UseGuards(AdminAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List logs (admin only)',
    description: 'Returns paginated logs with optional search and filters.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of logs' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async listAdmin(@Query() dto: AdminListLogsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    return this.logService.listForAdmin({
      page,
      limit,
      q: dto.q,
      entity_type: dto.entity_type,
      created_from: dto.created_from,
      created_to: dto.created_to,
    });
  }
}
