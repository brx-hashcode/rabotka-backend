import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { OfferDraftDto } from './dto/offer-draft.dto';
import { OfferWriterService } from './offer-writer.service';

/** « Rédiger avec l'IA » in the offer form. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/offer-drafts')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class OfferWriterController {
  constructor(private readonly writer: OfferWriterService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Write an offer from a few words (title, description, trade, type)',
    description:
      'Takes one of the plan’s « offres rédigées par l’IA » (403 when none is left or the plan has none); a draft that could not be written is given back (503). Nothing is saved: the form is filled, the business edits and publishes.',
  })
  draft(@Req() req: ProfileAuthenticatedRequest, @Body() dto: OfferDraftDto) {
    return this.writer.draft(req.user.profileId, dto);
  }
}
