import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiCookieAuth,
} from '@nestjs/swagger';
import { JobOfferService } from './job-offer.service';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminListJobOffersDto } from './dto/admin-list-job-offers.dto';

@ApiTags('Admin – Job Offers')
@Controller('admin/job-offers')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminJobOfferController {
  constructor(private readonly jobOfferService: JobOfferService) {}

  @Get()
  @ApiOperation({
    summary: 'List job offers (admin only)',
    description:
      'Returns paginated job offers with optional search and filters: status, payment_flow.',
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
      paymentFlow: dto.payment_flow,
    });
  }
}
