import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from './decorators/public.decorator';
import { AuthService } from './auth.service';
import { setAuthCookie } from './auth-cookie.util';
import { DEFAULT_LOGIN_LANDING } from './whatsapp-login-link.service';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

/** base64url, as minted — anything else cannot be one of ours. */
const CODE_PATTERN = /^[\w-]{16,128}$/;

/**
 * The one-tap entry point for every WhatsApp link: `/s/<code>`.
 *
 * A bot link cannot carry a session, and WhatsApp's WebView keeps nothing
 * between visits, so without this each notification costs the user an OTP. The
 * code resolves to both the profile and the destination, which is what lets a
 * template button be the fixed string `…/s/{{1}}` — one variable, at the end,
 * where WhatsApp requires it.
 *
 * Mirrors the ad tracker (`/r/:hash`): the client route of the same name simply
 * forwards here, and this redirects on to the real page.
 */
@Public()
@ApiExcludeController()
@Controller('s')
export class LoginLinkController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly logService: LogService,
  ) {}

  @Get(':code')
  // A code is a bearer credential; keep brute-force room small.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async open(
    @Param('code') code: string,
    @Res() res: Response,
    @Req() req: Request,
  ): Promise<void> {
    const meta = extractRequestMeta(req);

    if (!CODE_PATTERN.test(code)) {
      return this.fallback(res, DEFAULT_LOGIN_LANDING);
    }

    try {
      const result = await this.authService.loginWithWhatsAppCode(code);
      setAuthCookie(res, this.configService, result.token);

      await this.logService
        .create({
          action: 'auth.whatsapp_link.consumed',
          entityType: 'Profile',
          entityId: result.profileId,
          ...meta,
        })
        .catch(() => undefined);

      // Absolute, so the redirect works whichever host served the link.
      res.redirect(`${this.frontendUrl()}/${result.path}`);
    } catch {
      // Already used, expired, or a suspended account. Never show an error page
      // for a link someone tapped in good faith — fall back to the login screen
      // pointed at where they were going, which is exactly today's behaviour.
      await this.logService
        .create({
          action: 'auth.whatsapp_link.rejected',
          entityType: 'Profile',
          ...meta,
        })
        .catch(() => undefined);

      this.fallback(res, DEFAULT_LOGIN_LANDING);
    }
  }

  private fallback(res: Response, path: string): void {
    res.redirect(
      `${this.frontendUrl()}/login?redirect=${encodeURIComponent(`/${path}`)}`,
    );
  }

  private frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }
}
