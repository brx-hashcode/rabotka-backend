import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { CvGridService } from './cv-grid.service';
import { CvRescoreService } from './cv-rescore.service';
import { CvGridDto } from './dto/cv-grid.dto';

/**
 * « Critères »: what an offer's candidates (or an analysis's CVs) are marked
 * on. Read by the whole team; changed by those who hire (team-access.ts
 * refuses an Évaluateur every change it does not list).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CvGridController {
  constructor(
    private readonly grids: CvGridService,
    private readonly rescoring: CvRescoreService,
  ) {}

  @Get('offers/:offerId/cv-grid')
  @ApiOperation({ summary: 'The criteria an offer’s candidates are marked on' })
  async ofOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.grids.view(
      await this.grids.ofOffer(req.user.profileId, offerId),
    );
  }

  @Put('offers/:offerId/cv-grid')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Change them; a new importance applies at once, for free',
  })
  async saveForOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: CvGridDto,
  ) {
    return this.grids.save(
      await this.grids.ofOffer(req.user.profileId, offerId),
      dto.items,
      req.user.memberId ?? null,
    );
  }

  @Post('offers/:offerId/cv-grid/proposal')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'The AI’s proposal for the offer as it is now' })
  async proposeForOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.grids.propose(
      await this.grids.ofOffer(req.user.profileId, offerId),
    );
  }

  @Post('offers/:offerId/cv-grid/rescore')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read its candidates again on these criteria' })
  async rescoreOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.rescoring.start(
      await this.grids.ofOffer(req.user.profileId, offerId),
    );
  }

  @Get('cv-screenings/:id/grid')
  @ApiOperation({ summary: 'The criteria an analysis’s CVs are marked on' })
  async ofScreening(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.grids.view(
      await this.grids.ofScreening(req.user.profileId, id),
    );
  }

  @Put('cv-screenings/:id/grid')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Change them' })
  async saveForScreening(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CvGridDto,
  ) {
    return this.grids.save(
      await this.grids.ofScreening(req.user.profileId, id),
      dto.items,
      req.user.memberId ?? null,
    );
  }

  @Post('cv-screenings/:id/grid/proposal')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'The AI’s proposal for this analysis’s job' })
  async proposeForScreening(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.grids.propose(
      await this.grids.ofScreening(req.user.profileId, id),
    );
  }

  @Post('cv-screenings/:id/grid/rescore')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read its CVs again on these criteria' })
  async rescoreScreening(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rescoring.start(
      await this.grids.ofScreening(req.user.profileId, id),
    );
  }

  @Get('cv-screenings/:id/explain')
  @ApiOperation({ summary: 'Why one of its CVs is ahead of another' })
  explain(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('a', ParseUUIDPipe) a: string,
    @Query('b', ParseUUIDPipe) b: string,
  ) {
    return this.grids.explain(req.user.profileId, id, a, b);
  }
}
