import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { imageMulterOptions } from '../../../common/utils/image-upload.util';
import { LinkedinPostDto } from './dto/linkedin.dto';
import {
  linkedinCallbackPage,
  type LinkedinCallbackStatus,
} from './linkedin-callback-page';
import { LinkedinService } from './linkedin.service';

/**
 * The signed-in person's own LinkedIn, and the offers posted on it. An
 * Évaluateur reads but changes nothing (team-access.ts refuses its POSTs).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/linkedin')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class LinkedinController {
  constructor(private readonly linkedin: LinkedinService) {}

  @Get()
  @ApiOperation({ summary: 'Its LinkedIn account, if connected' })
  account(@Req() req: ProfileAuthenticatedRequest) {
    return this.linkedin.account(req.user.profileId, req.user.memberId);
  }

  @Post('connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The LinkedIn consent screen to open' })
  connect(@Req() req: ProfileAuthenticatedRequest) {
    return this.linkedin.connectUrl(req.user.profileId, req.user.memberId);
  }

  @Delete()
  @ApiOperation({ summary: 'Disconnect its LinkedIn account' })
  disconnect(@Req() req: ProfileAuthenticatedRequest) {
    return this.linkedin.disconnect(req.user.profileId, req.user.memberId);
  }

  @Post('posts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('image', imageMulterOptions(8 * 1024 * 1024)),
  )
  @ApiOperation({
    summary:
      'Post an offer on its LinkedIn (queued); `image` replaces the offer’s share picture',
  })
  post(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: LinkedinPostDto,
    @UploadedFile() image: Express.Multer.File | undefined,
  ) {
    return this.linkedin.queuePost(
      req.user.profileId,
      req.user.memberId,
      dto.offerId,
      dto.text,
      dto.again ?? false,
      image?.buffer,
      dto.offerImage ?? false,
    );
  }

  @Get('offers/:offerId/posts')
  @ApiOperation({ summary: 'An offer’s LinkedIn posts, newest first' })
  posts(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.linkedin.posts(req.user.profileId, offerId);
  }
}

/** Where LinkedIn sends the member back after consenting. */
@ApiTags('Public')
@Controller('public/linkedin')
export class LinkedinCallbackController {
  private readonly logger = new Logger(LinkedinCallbackController.name);

  constructor(private readonly linkedin: LinkedinService) {}

  @Public()
  @Get('callback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'OAuth redirect of a LinkedIn connection' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let status: LinkedinCallbackStatus = 'error';
    if (
      error === 'user_cancelled_login' ||
      error === 'user_cancelled_authorize'
    ) {
      status = 'denied';
    } else if (code && state && !error) {
      try {
        await this.linkedin.complete(code, state);
        status = 'connected';
      } catch (err) {
        this.logger.warn(`LinkedIn connection failed: ${String(err)}`);
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    );
    res.send(linkedinCallbackPage(status));
  }
}
