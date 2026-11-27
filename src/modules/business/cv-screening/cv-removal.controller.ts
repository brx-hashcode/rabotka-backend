import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { CvRemovalService } from './cv-removal.service';
import { OpenToBlockedBusiness } from '../../auth/decorators/open-to-blocked-business.decorator';

/**
 * « Supprimer le CV » of one candidate. Not for an Évaluateur (team-access.ts
 * refuses it every change it does not list). Answered with a body, never an
 * empty 204: the front's client reads every success as JSON.
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
// Deleting a CV only takes data away: a blocked business may still do it.
@OpenToBlockedBusiness()
export class CvRemovalController {
  constructor(private readonly removal: CvRemovalService) {}

  @Delete('applications/:id/cv')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete the CV of a Rabotka application; its score stays',
  })
  async application(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    await this.removal.application(req.user.profileId, id);
    return { deleted: true };
  }

  @Delete('external-applications/:id/cv')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete the CV of a careers-page or imported candidate',
  })
  async external(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    await this.removal.external(req.user.profileId, id);
    return { deleted: true };
  }

  @Delete('cv-screenings/:id/resumes/:resumeId/file')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Delete one CV of an analysis; its score stays' })
  async resume(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
  ): Promise<{ deleted: true }> {
    await this.removal.resume(req.user.profileId, id, resumeId);
    return { deleted: true };
  }
}
