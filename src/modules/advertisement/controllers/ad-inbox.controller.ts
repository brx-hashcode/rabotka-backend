import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { AdInboxService } from '../services/ad-inbox.service';

@ApiTags('advertisements')
@Controller('ads')
@UseGuards(ProfileAuthGuard)
export class AdInboxController {
  constructor(private readonly adInbox: AdInboxService) {}

  @Get('inbox')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Pending in-app advertisements for the current profile',
    description:
      'Advertisements dispatched on the IN_APP channel that the profile has not dismissed yet.',
  })
  @ApiResponse({ status: 200, description: 'Pending advertisements returned' })
  list(@Req() req: ProfileAuthenticatedRequest) {
    return this.adInbox.listPending(req.user.profileId);
  }

  @Post('inbox/:deliveryId/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Dismiss an in-app advertisement',
    description:
      'Marks the delivery as opened so the popup is not shown again. Idempotent.',
  })
  @ApiResponse({ status: 204, description: 'Advertisement dismissed' })
  async markSeen(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
  ): Promise<void> {
    await this.adInbox.markSeen(req.user.profileId, deliveryId);
  }
}
