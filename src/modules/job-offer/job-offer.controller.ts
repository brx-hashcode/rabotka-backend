import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JobOfferService } from './job-offer.service';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { BotNotificationService } from '../bot/services/bot-notification.service';

@ApiTags('Job Offers')
@Controller('job-offers')
@UseGuards(ProfileAuthGuard)
export class JobOfferController {
  constructor(
    private readonly jobOfferService: JobOfferService,
    private readonly botNotification: BotNotificationService,
  ) {}

  @Post()
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
    const offer = await this.jobOfferService.create(req.user.profileId, dto);

    // Best-effort WhatsApp confirmation (recap + copyable reference). Triggered
    // here — not in the shared service — so the bot flow keeps its own inline
    // confirmation and we don't double-send.
    void this.botNotification.sendJobCreatedConfirmation(offer.id);

    return offer;
  }
}
