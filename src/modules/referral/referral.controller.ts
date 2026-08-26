import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ReferralService } from './referral.service';

@ApiTags('Referral')
@Controller('referral')
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('me')
  @UseGuards(ProfileAuthGuard)
  @ApiBearerAuth()
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      "Own parrainage code, current amounts and counts. Mints the code on first call.",
  })
  getOwn(@Req() req: ProfileAuthenticatedRequest) {
    return this.referralService.getOwnReferralSummary(req.user.profileId);
  }

  /**
   * Live check for the code field on the signup screen.
   *
   * Public because the person typing the code does not have an account yet —
   * that is the entire point of the field. Throttled, and answering with only a
   * first name and a last initial, so it stays a confirmation ("yes, that is
   * your friend") rather than a way to walk the user base.
   */
  @Get('resolve/:code')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resolve a parrainage code to a display name' })
  async resolve(@Param('code') code: string) {
    const match = await this.referralService.resolveCode(code);
    // 200 with found:false rather than a 404: an unknown code is an expected
    // answer here, not an error, and the client renders it inline under the
    // input without an error boundary catching anything.
    return match ? { found: true, ...match } : { found: false };
  }
}
