import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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

  @Post(':offerId/applications/analyse')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'CV analysis of the Rabotka applicants not read yet (1 « CV inclus » each)',
  })
  analyseAll(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.scores.analyse(req.user.profileId, offerId);
  }

  @Post(':offerId/applications/:applicationId/analyse')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'CV analysis of one Rabotka applicant (1 « CV inclus »)',
  })
  analyseOne(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
  ) {
    return this.scores.analyse(req.user.profileId, offerId, applicationId);
  }
}
