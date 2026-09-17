import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBasicAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { Public } from '../auth/decorators/public.decorator';
import { OAuthExceptionFilter } from '../oauth/filters/oauth-exception.filter';
import { CreateIdentityCheckDto } from './dto';
import { PartnerApiCallKind } from '@prisma/client';
import { PartnerApiCall } from '../partner-activity/partner-api-call.decorator';
import { PartnerRequestLogInterceptor } from '../partner-activity/partner-request-log.interceptor';
import {
  PartnerClientAuthGuard,
  type PartnerRequest,
} from './guards/partner-client-auth.guard';
import { IdentityCheckService } from './identity-check.service';

const IDEMPOTENCY_KEY_MAX = 128;

/**
 * The partner API. Called by a partner's backend with HTTP Basic client
 * credentials, which is why these routes are in the CSRF skip list.
 */
@ApiTags('Identity checks (partner API)')
@ApiBasicAuth()
@Controller('identity-checks')
@UseFilters(OAuthExceptionFilter)
@UseGuards(PartnerClientAuthGuard)
@UseInterceptors(PartnerRequestLogInterceptor)
export class PartnerIdentityCheckController {
  constructor(private readonly checks: IdentityCheckService) {}

  @Public()
  @PartnerApiCall(PartnerApiCallKind.IDENTITY_CHECK_CREATE)
  @Post()
  @HttpCode(202)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retries with the same key return the original check.',
  })
  @ApiOperation({
    summary:
      'Ask the person behind a WhatsApp number to confirm their identity',
  })
  create(
    @Body() dto: CreateIdentityCheckDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: PartnerRequest,
  ) {
    const key =
      idempotencyKey?.trim().slice(0, IDEMPOTENCY_KEY_MAX) || undefined;
    return this.checks.create(
      req.partnerApp,
      dto,
      key,
      extractRequestMeta(req),
    );
  }

  @Public()
  @PartnerApiCall(PartnerApiCallKind.IDENTITY_CHECK_READ)
  @Get(':id')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read an identity check and, once completed, its result',
  })
  get(@Param('id', ParseUUIDPipe) id: string, @Req() req: PartnerRequest) {
    return this.checks.getForApp(req.partnerApp, id);
  }
}
