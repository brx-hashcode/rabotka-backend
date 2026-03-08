import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { PenaltyService } from './penalty.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListPenaltiesDto } from './dto/admin-list-penalties.dto';

@ApiTags('Admin – Penalties')
@Controller('admin/penalties')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminPenaltyController {
  constructor(private readonly penaltyService: PenaltyService) {}

  @Get()
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
    });
  }
}
