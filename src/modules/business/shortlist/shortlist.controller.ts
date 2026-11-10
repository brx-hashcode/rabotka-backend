import {
  Body,
  Controller,
  Delete,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { BulkShortlistDto } from './dto/shortlist.dto';
import { ShortlistService, type ShortlistKind } from './shortlist.service';

/** `rabotka` or `external`, as in candidate-notes. */
const KIND = new ParseEnumPipe({
  rabotka: 'rabotka',
  external: 'external',
} as const);

/**
 * « Présélectionner »: one candidature from its card (its route names it, so
 * the Historique says who), or several of one offer from the selection or
 * the board. Hiring roles only (team-access: a Évaluateur is refused).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class ShortlistController {
  constructor(private readonly shortlist: ShortlistService) {}

  @Post('applications/:kind/:id/shortlist')
  @ApiParam({ name: 'kind', enum: ['rabotka', 'external'] })
  @ApiOperation({
    summary: 'Shortlist a candidature (« Présélectionnée »)',
    description:
      'Only while it waits; the candidate is never told. 409 once retained or refused.',
  })
  add(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ShortlistKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shortlist.set(req.user.profileId, kind, id, true);
  }

  @Delete('applications/:kind/:id/shortlist')
  @ApiParam({ name: 'kind', enum: ['rabotka', 'external'] })
  @ApiOperation({ summary: 'Take a candidature off the shortlist' })
  remove(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('kind', KIND) kind: ShortlistKind,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shortlist.set(req.user.profileId, kind, id, false);
  }

  @Post('offers/:offerId/applications/shortlist')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Shortlist, or take off, several candidatures of an offer',
    description:
      'Only those still waiting change; the others are counted as skipped.',
  })
  bulk(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: BulkShortlistDto,
  ) {
    return this.shortlist.bulk(req.user.profileId, offerId, dto);
  }
}
