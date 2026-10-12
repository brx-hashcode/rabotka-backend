import { Public } from '../auth/decorators/public.decorator';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { AgentAuthService } from './agent-auth.service';
import {
  AgentLogoutDto,
  AgentRefreshDto,
  AgentSendOtpDto,
  AgentVerifyOtpDto,
} from './dto/agent-auth.dto';
import { AgentAuthGuard } from './guards/agent-auth.guard';

/**
 * Login for the agent app. Public by necessity — the caller has no session
 * yet — and CSRF-exempt (csrf-exempt.ts): the agent app holds no cookie, its
 * tokens travel in the response body and the Authorization header.
 *
 * Throttled per IP on top of the per-email send cap in otp-store.ts.
 */
@ApiTags('Agent – Auth')
@Controller('agent/auth')
export class AgentAuthController {
  constructor(private readonly agentAuth: AgentAuthService) {}

  @Public()
  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Send a login code to an agent email',
    description:
      'Always answers success, whether or not the email belongs to an active agent.',
  })
  @ApiResponse({ status: 200, description: 'Accepted' })
  @ApiResponse({ status: 429, description: 'Too many codes requested' })
  sendOtp(@Body() dto: AgentSendOtpDto) {
    return this.agentAuth.sendOtp(dto.email);
  }

  @Public()
  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend the login code (60s cooldown)' })
  @ApiResponse({ status: 200, description: 'Accepted' })
  @ApiResponse({ status: 429, description: 'Cooldown active or cap reached' })
  resendOtp(@Body() dto: AgentSendOtpDto) {
    return this.agentAuth.resendOtp(dto.email);
  }

  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Verify the code and issue agent tokens',
    description:
      'Returns an access token, a single-use refresh token and the agent profile.',
  })
  @ApiResponse({ status: 200, description: 'Tokens issued' })
  @ApiResponse({ status: 401, description: 'Invalid or expired code' })
  verifyOtp(@Body() dto: AgentVerifyOtpDto, @Req() req: Request) {
    return this.agentAuth.verifyOtp(
      dto.email,
      dto.otp,
      extractRequestMeta(req),
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate the token pair' })
  @ApiResponse({ status: 200, description: 'New token pair issued' })
  @ApiResponse({ status: 401, description: 'Invalid, expired or used token' })
  refresh(@Body() dto: AgentRefreshDto) {
    return this.agentAuth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AgentAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  async logout(
    @Req() req: Request,
    @Body() dto: AgentLogoutDto,
  ): Promise<{ success: true }> {
    // AgentAuthGuard has already required a Bearer header.
    const accessToken = req.headers.authorization!.slice(7);
    await this.agentAuth.logout(accessToken, dto.refreshToken);
    return { success: true };
  }
}
