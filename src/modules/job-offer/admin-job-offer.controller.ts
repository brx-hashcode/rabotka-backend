import {
  Controller,
  Get,
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
import { AdminUpdateJobOfferStatusDto } from './dto/admin-update-job-offer-status.dto';
import { LogService } from '../log/log.service';

@ApiTags('Admin – Job Offers')
@Controller('admin/job-offers')
@UseGuards(AdminAuthGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminJobOfferController {
  constructor(
    private readonly jobOfferService: JobOfferService,
    private readonly logService: LogService,
  ) {}

  @Get()
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

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update job offer status (admin only)',
    description: 'Updates the status of a job offer (e.g. ACTIVE, CANCELLED).',
  })
  @ApiResponse({ status: 200, description: 'Updated job offer' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: AdminUpdateJobOfferStatusDto,
    @Req() req: any,
  ) {
    const result = await this.jobOfferService.updateStatusByAdmin(id, dto.status);
    await this.logService.create({
      action: 'JOB_OFFER_STATUS_CHANGED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
      metadata: { status: dto.status },
    });
    return result;
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update job offer (admin only)',
    description: 'Updates job offer fields like title, description, amount, etc.',
  })
  @ApiResponse({ status: 200, description: 'Updated job offer details' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async update(
    @Param('id') id: string,
    @Body() dto: AdminUpdateJobOfferDto,
    @Req() req: any,
  ) {
    const result = await this.jobOfferService.updateJobOfferByAdmin(id, dto);
    await this.logService.create({
      action: 'JOB_OFFER_UPDATED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
      metadata: { fields: dto },
    });
    return result;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete job offer (admin only)',
    description: 'Permanently deletes a job offer and its related data.',
  })
  @ApiResponse({ status: 204, description: 'Job offer deleted' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.jobOfferService.deleteJobOfferByAdmin(id);
    await this.logService.create({
      action: 'JOB_OFFER_DELETED',
      entityType: 'JobOffer',
      entityId: id,
      userId: req.user?.userId,
    });
  }
}
