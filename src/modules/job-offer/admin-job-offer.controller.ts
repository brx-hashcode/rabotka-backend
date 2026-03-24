import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { JobOfferStatus } from '@prisma/client';
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
import { AdminUpdateJobOfferDto } from './dto/admin-update-job-offer.dto';

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

  @Get(':id')
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

  @Patch(':id')
  @ApiOperation({
    summary: 'Update job offer (admin only)',
    description:
      'Updates job offer fields like title, description, amount, etc.',
  })
  @ApiResponse({ status: 200, description: 'Updated job offer details' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async update(@Param('id') id: string, @Body() dto: AdminUpdateJobOfferDto) {
    return await this.jobOfferService.updateJobOfferByAdmin(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update job offer status (admin only)' })
  @ApiResponse({ status: 200, description: 'Updated job offer details' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string },
  ) {
    const allowed: JobOfferStatus[] = [
      JobOfferStatus.ACTIVE,
      JobOfferStatus.CANCELLED,
      JobOfferStatus.EXPIRED,
    ];
    if (!allowed.includes(body.status as JobOfferStatus)) {
      throw new BadRequestException(
        `Status must be one of: ${allowed.join(', ')}`,
      );
    }
    return this.jobOfferService.updateJobOfferStatusByAdmin(
      id,
      body.status as JobOfferStatus,
    );
  }

  @Post(':id/confirm-payment')
  @ApiOperation({
    summary: 'Confirm payment and activate job offer (admin only)',
  })
  @ApiResponse({ status: 201, description: 'Job offer activated' })
  @ApiResponse({ status: 400, description: 'Not in PENDING_PAYMENT status' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async confirmPayment(@Param('id') id: string) {
    return this.jobOfferService.confirmJobPaymentByAdmin(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete job offer (admin only)',
    description: 'Permanently deletes a job offer and its related data.',
  })
  @ApiResponse({ status: 200, description: 'Job offer deleted' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async remove(@Param('id') id: string) {
    return this.jobOfferService.deleteJobOfferByAdmin(id);
  }
}
