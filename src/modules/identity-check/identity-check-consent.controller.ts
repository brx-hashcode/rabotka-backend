import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { IdentityCheckService } from './identity-check.service';

/**
 * The person's side: the page the WhatsApp button opens. A check is only
 * visible to the profile it was sent to.
 */
@ApiTags('Profile — Identity checks')
@ApiBearerAuth()
@Controller('profile/identity-checks')
@UseGuards(ProfileAuthGuard)
export class IdentityCheckConsentController {
  constructor(private readonly checks: IdentityCheckService) {}

  @Get(':id')
  @ApiOperation({
    summary: '[Web/PROFILE] An identity-check request sent to me',
  })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: ProfileAuthenticatedRequest,
  ) {
    return this.checks.getForProfile(req.user.profileId, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: '[Web/PROFILE] Let Rabotka answer the partner' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: ProfileAuthenticatedRequest,
  ) {
    return this.checks.approve(req.user.profileId, id, extractRequestMeta(req));
  }

  @Post(':id/decline')
  @HttpCode(200)
  @ApiOperation({ summary: '[Web/PROFILE] Refuse the identity check' })
  decline(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: ProfileAuthenticatedRequest,
  ) {
    return this.checks.decline(req.user.profileId, id, extractRequestMeta(req));
  }
}
