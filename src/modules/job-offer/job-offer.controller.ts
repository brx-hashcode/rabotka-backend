import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JobOfferService } from './job-offer.service';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { RepublishJobOfferDto } from './dto/republish-job-offer.dto';

@ApiTags('Job Offers')
@Controller('job-offers')
@UseGuards(ProfileAuthGuard)
export class JobOfferController {
  constructor(
    private readonly jobOfferService: JobOfferService,
  ) {}

  @Post()
  @UseGuards(KycVerifiedGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Publish a job offer (employer). Returns the created offer.',
  })
  async create(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: CreateJobOfferDto,
  ) {
    // EMPLOYER enforcement (profile type, account status, reliability, hard-block)
    // lives inside JobOfferService.create() and throws Forbidden otherwise.
    // Publishing sends no WhatsApp message: the employer is already on the web
    // form and gets the reference on the success screen, so a push adds nothing
    // but noise. The bot's own publish flow still answers inline, in-conversation.
    return this.jobOfferService.create(req.user.profileId, dto);
  }

  @Post(':id/republish')
  @UseGuards(KycVerifiedGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Republish an expired job offer at a new date (employer).',
    description:
      'Reopens an EXPIRED offer by setting a new start date and returning it to ACTIVE. Previously only possible from the WhatsApp expiry message, which left employers who ignored it with no way to reopen the offer.',
  })
  @ApiResponse({ status: 201, description: 'The republished offer' })
  @ApiResponse({
    status: 400,
    description: 'Offer is not EXPIRED, or the date is under 4 hours away',
  })
  @ApiResponse({ status: 403, description: 'Not the offer owner' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async republish(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RepublishJobOfferDto,
  ) {
    return this.jobOfferService.republish(
      id,
      req.user.profileId,
      new Date(dto.scheduledAt),
    );
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Get a single job offer by id (with employer info).',
  })
  @ApiResponse({ status: 200, description: 'The job offer detail' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async getById(@Param('id') id: string) {
    const offer = await this.jobOfferService.findById(id);
    if (!offer) {
      throw new NotFoundException('Offre introuvable');
    }
    return offer;
  }
}
