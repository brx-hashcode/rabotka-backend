import {
  Controller,
  Delete,
  HttpCode,
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

/**
 * « Supprimer le CV » of one candidate. Not for an Évaluateur (team-access.ts
 * refuses it every change it does not list).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class CvRemovalController {
  constructor(private readonly removal: CvRemovalService) {}

  @Delete('applications/:id/cv')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete the CV of a Rabotka application; its score stays',
  })
  application(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.removal.application(req.user.profileId, id);
  }

  @Delete('external-applications/:id/cv')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Delete the CV of a careers-page or imported candidate',
  })
  external(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.removal.external(req.user.profileId, id);
  }

  @Delete('cv-screenings/:id/resumes/:resumeId/file')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Delete one CV of an analysis; its score stays' })
  resume(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('resumeId', ParseUUIDPipe) resumeId: string,
  ): Promise<void> {
    return this.removal.resume(req.user.profileId, id, resumeId);
  }
}
