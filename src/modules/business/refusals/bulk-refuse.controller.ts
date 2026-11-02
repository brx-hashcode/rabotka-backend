import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { BulkRefuseDto } from './dto/bulk-refuse.dto';
import { BulkRefuseService } from './bulk-refuse.service';

/** « Refuser la sélection » and « Refuser les autres candidatures ». */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/offers')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BulkRefuseController {
  constructor(private readonly refusals: BulkRefuseService) {}

  @Post(':offerId/applications/refuse')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Refuse several applications of an offer, with one message',
    description:
      '`applicationIds`, or `remaining: true` for every application still waiting. Each goes through the usual refusal (the candidate is told, with the message). Only waiting applications are refused; the others are counted as skipped.',
  })
  refuse(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: BulkRefuseDto,
  ) {
    return this.refusals.refuse(req.user.profileId, offerId, dto);
  }
}
