import {
  BadRequestException,
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
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { Public } from '../../auth/decorators/public.decorator';
import { MailboxMailsQueryDto } from './dto/mailbox.dto';
import { callbackPage } from './mailbox-callback-page';
import {
  MailboxService,
  PROVIDER_OF,
  type ProviderSlug,
} from './mailbox.service';

function slug(value: string): ProviderSlug {
  if (value in PROVIDER_OF) return value as ProviderSlug;
  throw new BadRequestException('Messagerie inconnue.');
}

/** The mailboxes a business picks CVs from, for « Analyse de CV ». */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/mailboxes')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class MailboxController {
  constructor(private readonly mailboxes: MailboxService) {}

  @Get()
  @ApiOperation({
    summary: 'Its connected mailboxes, and which can be connected',
  })
  list(@Req() req: ProfileAuthenticatedRequest) {
    return this.mailboxes.list(req.user.profileId);
  }

  @Post(':provider/connect')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'The consent screen to open, for gmail or outlook' })
  connect(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('provider') provider: string,
  ) {
    return this.mailboxes.connectUrl(req.user.profileId, slug(provider));
  }

  @Get(':id/mails')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Recent mails with a CV attached (read on demand)' })
  mails(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: MailboxMailsQueryDto,
  ) {
    return this.mailboxes.mails(req.user.profileId, id, query.q, query.page);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Disconnect a mailbox (its tokens are revoked)' })
  disconnect(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mailboxes.disconnect(req.user.profileId, id);
  }
}

/** Where Google and Microsoft send the business back after consenting. */
@ApiTags('Public')
@Controller('public/mailbox')
export class MailboxCallbackController {
  private readonly logger = new Logger(MailboxCallbackController.name);

  constructor(private readonly mailboxes: MailboxService) {}

  @Public()
  @Get('callback/:provider')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'OAuth redirect of a mailbox connection' })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let status: 'connected' | 'error' | 'denied' = 'error';
    if (error === 'access_denied') {
      status = 'denied';
    } else if (code && state && !error) {
      try {
        await this.mailboxes.complete(slug(provider), code, state);
        status = 'connected';
      } catch (err) {
        this.logger.warn(
          `Mailbox connection failed (${provider}): ${String(err)}`,
        );
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
    );
    res.send(callbackPage(status));
  }
}
