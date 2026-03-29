import {
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
import { PenaltyService } from './penalty.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListPenaltiesDto } from './dto/admin-list-penalties.dto';

@ApiTags('Admin - Penalties')
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

  @Get(':id')
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
  @ApiOperation({
    summary: 'Manually confirm penalty payment (admin only)',
    description:
      'Records the penalty as paid, credits the system wallet, and updates the worker billing status.',
  })
  @ApiResponse({ status: 201, description: 'Penalty payment confirmed' })
  @ApiResponse({ status: 400, description: 'Penalty already paid' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async confirmPayment(@Param('id') id: string, @Req() req: any) {
    return await this.penaltyService.confirmPenaltyPaymentByAdmin(
      id,
      req.user.userId,
    );
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a penalty (admin only)',
    description:
      'Permanently deletes a penalty and re-syncs the worker billing status.',
  })
  @ApiResponse({ status: 200, description: 'Penalty deleted' })
  @ApiResponse({ status: 404, description: 'Penalty not found' })
  async deletePenalty(@Param('id') id: string) {
    return await this.penaltyService.deletePenalty(id);
  }
}
