import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ApplicantScoreService } from './applicant-score.service';

/** The applicants of an offer, scored against it (« classés par adéquation »). */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/offers')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class ApplicantScoreController {
  constructor(private readonly scores: ApplicantScoreService) {}

  @Get(':offerId/assessments')
  @ApiOperation({
    summary: 'Each applicant’s fit with the offer (score, criteria, points)',
    description:
      'Made in the background for every application to a business offer; `pending` counts those not scored yet.',
  })
  forOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.scores.forOffer(req.user.profileId, offerId);
  }
}
