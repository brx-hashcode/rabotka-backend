import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
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
import type { Request, Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import { KycVerifiedGuard } from '../../auth/guards/kyc-verified.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { imageMulterOptions } from '../../../common/utils/image-upload.util';
import { LinkedinPostDto } from './dto/linkedin.dto';
import {
  linkedinCallbackPage,
  type LinkedinCallbackStatus,
} from './linkedin-callback-page';
import { LINKEDIN_SESSION_MISMATCH, LinkedinService } from './linkedin.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type Redis from 'ioredis';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { callbackSession } from '../connect-session';
import { OpenToBlockedBusiness } from '../../auth/decorators/open-to-blocked-business.decorator';

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
  // Reaches candidates or uses the plan: only once the organisation is approved.
  @UseGuards(KycVerifiedGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The LinkedIn consent screen to open' })
  connect(@Req() req: ProfileAuthenticatedRequest) {
    return this.linkedin.connectUrl(req.user.profileId, req.user.memberId);
  }

  @Delete()
  @OpenToBlockedBusiness()
  @ApiOperation({ summary: 'Disconnect its LinkedIn account' })
  disconnect(@Req() req: ProfileAuthenticatedRequest) {
    return this.linkedin.disconnect(req.user.profileId, req.user.memberId);
  }

  @Post('posts')
  // Reaches candidates or uses the plan: only once the organisation is approved.
  @UseGuards(KycVerifiedGuard)
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

  constructor(
    private readonly linkedin: LinkedinService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  @Public()
  @Get('callback')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'OAuth redirect of a LinkedIn connection' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
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
        const session = await callbackSession(
          {
            jwt: this.jwt,
            config: this.config,
            redis: this.redis,
            prisma: this.prisma,
          },
          req,
        );
        await this.linkedin.complete(code, state, session);
        status = 'connected';
      } catch (err) {
        if (err instanceof Error && err.message === LINKEDIN_SESSION_MISMATCH) {
          status = 'session';
        }
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
