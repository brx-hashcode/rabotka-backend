import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { AuthService } from '../auth/auth.service';
import { readAuthCookie, setAuthCookie } from '../auth/auth-cookie.util';
import { OAuthError } from './oauth-error';
import { OAuthExceptionFilter } from './filters/oauth-exception.filter';
import { OAuthAuthorizationService } from './services/oauth-authorization.service';
import { OAuthInteractionService } from './services/oauth-interaction.service';
import { OAuthSandboxService } from './services/oauth-sandbox.service';
import {
  ConsentDecisionDto,
  SendInteractionOtpDto,
  VerifyInteractionOtpDto,
} from './dto';
import { canAuthenticateToPartner } from './utils/claims.util';
import { PrismaService } from '../../common/services/prisma/prisma.service';

/**
 * The browser-facing half of "Login with Rabotka".
 *
 * `GET authorize` is where a partner sends the user; everything under
 * `interaction/` is called by Rabotka's own consent page as the user works
 * through it. That split is deliberate: the interaction endpoints are same-site
 * calls from `FRONTEND_URL` carrying the session cookie, so they stay behind
 * CSRF protection, while `authorize` is a plain cross-site navigation and
 * cannot carry a CSRF token at all.
 */
@ApiTags('OpenID Connect')
@Controller('oauth')
@UseFilters(OAuthExceptionFilter)
export class OAuthAuthorizeController {
  constructor(
    private readonly authorization: OAuthAuthorizationService,
    private readonly interactions: OAuthInteractionService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sandbox: OAuthSandboxService,
  ) {}

  /**
   * The entry point a partner's "Se connecter avec Rabotka" button leads to.
   *
   * Always ends in a redirect — to Rabotka's consent page on success, to the
   * partner with an `error=` on a bad request, or to Rabotka's own error page
   * when the request is too broken to trust a redirect URI from.
   */
  @Public()
  @Get('authorize')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'OIDC authorization endpoint' })
  async authorize(
    @Query() query: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Reuse a live Rabotka session if the browser has one, so a user who is
    // already signed in sees only the consent screen. This is what makes the
    // second partner app a single tap, and it works cross-site because the
    // session cookie is already SameSite=None in production for the WhatsApp
    // WebView.
    //
    // `prompt=login` overrides it: a partner that wants the user re-challenged
    // (a payment confirmation, say) can ask, and OIDC Core defines the
    // parameter for exactly that.
    let profileId: string | null = null;
    if (query.prompt !== 'login') {
      profileId = await this.auth.resolveSessionProfile(
        readAuthCookie(req, this.config),
      );
    }

    const { interactionId } = await this.authorization.beginAuthorization(
      query,
      profileId,
    );

    res.redirect(
      302,
      `${this.frontendUrl()}/oauth/consent?interaction=${encodeURIComponent(interactionId)}`,
    );
  }

  /** Everything the consent screen needs to draw itself. */
  @Public()
  @Get('interaction/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async context(@Param('id') id: string) {
    return this.authorization.consentContext(id);
  }

  /**
   * Sends an OTP to a phone number, for a user who has no live session.
   *
   * Phone only. Rabotka's own login also accepts an email address, but a
   * partner-facing flow that took either would let anyone who knows a user's
   * email address start a login against them, and the WhatsApp OTP is the
   * channel the `phone_number_verified` claim rests on.
   */
  @Public()
  @Post('interaction/:id/send-otp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sendOtp(@Param('id') id: string, @Body() dto: SendInteractionOtpDto) {
    const interaction = await this.interactions.require(id);
    const phone = dto.phone.trim();
    const sandboxUser = this.sandbox.findUserByPhone(phone);

    const noAccount = { sent: false, reason: 'no_account' as const };

    if (interaction.sandbox) {
      // A sandbox interaction may only ever address a sandbox number. Falling
      // through to `auth.sendOtp` for anything else would let a sandbox app
      // start a login against a real person, and would turn it into a free
      // "send a WhatsApp message to an arbitrary number" endpoint.
      if (!sandboxUser) return noAccount;
      // Nothing is sent and nothing is written to Redis. The code is fixed, so
      // there is no OTP to store and no message to deliver.
    } else {
      // The mirror of the branch above. The sandbox numbers are reserved
      // platform-wide rather than relying on the 404 that only happens to be
      // there because nobody has registered them — `profiles.phone` has no
      // format validation, so that accident is one INSERT away from untrue.
      if (sandboxUser) return noAccount;

      try {
        await this.auth.sendOtp(phone);
      } catch {
        // `AuthService.sendOtp` throws 404 for an unknown identifier, and here
        // that is not an error — it is the product's answer. Partners get
        // verified Rabotka users or nobody, so someone without an account is
        // told to create one rather than being offered a signup they did not
        // come here for. Returning 200 also means this endpoint cannot be used
        // as a "does this phone number have a Rabotka account" oracle.
        return noAccount;
      }
    }

    await this.interactions.patch(id, {
      pendingPhone: phone,
      scopes: interaction.scopes,
    });

    return { sent: true };
  }

  @Public()
  @Post('interaction/:id/verify-otp')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifyOtp(
    @Param('id') id: string,
    @Body() dto: VerifyInteractionOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const interaction = await this.interactions.require(id);
    const phone = dto.phone.trim();

    // The number being verified must be the number an OTP was sent to in THIS
    // interaction. Without this an attacker could start a flow, have the victim
    // request their own code elsewhere, and redeem it here against a different
    // interaction.
    if (interaction.pendingPhone !== phone) {
      throw new OAuthError(
        'invalid_request',
        'Demandez un nouveau code pour ce numéro.',
        400,
      );
    }

    if (interaction.sandbox) {
      const user = this.sandbox.verifyOtp(phone, dto.otp);

      if (!user) {
        // Same shape as a real failed attempt — same message, same interaction
        // burn after MAX_OTP_ATTEMPTS — so the consent screen branches
        // identically and a sandbox app is not distinguishable by its error
        // behaviour. A non-sandbox number reaching here is refused rather than
        // falling through to the real verify below.
        const { attemptsLeft } = await this.interactions.recordFailedOtp(id);
        throw new OAuthError(
          'access_denied',
          `Code incorrect. Il vous reste ${attemptsLeft} tentative${attemptsLeft > 1 ? 's' : ''}.`,
          401,
        );
      }

      await this.interactions.patch(id, {
        profileId: user.id,
        authTime: Math.floor(Date.now() / 1000),
        pendingPhone: undefined,
        otpAttempts: 0,
      });

      // No `issueProfileSession` and no `setAuthCookie`, deliberately. There is
      // no `profiles` row behind this id, so a session cookie would be a ghost
      // session: every authenticated endpoint in the SPA would fail on it. It
      // is also what keeps the sentinel out of `beginAuthorization` — with no
      // cookie there is nothing for `resolveSessionProfile` to hand back, so a
      // sandbox subject can never arrive at a real app as an existing session.
      return this.authorization.consentContext(id);
    }

    let profile: { id: string };
    try {
      profile = await this.auth.verifyOtpAndGetProfile(phone, dto.otp);
    } catch {
      // Burns the interaction after MAX_OTP_ATTEMPTS, then throws.
      const { attemptsLeft } = await this.interactions.recordFailedOtp(id);
      throw new OAuthError(
        'access_denied',
        `Code incorrect. Il vous reste ${attemptsLeft} tentative${attemptsLeft > 1 ? 's' : ''}.`,
        401,
      );
    }

    const full = await this.requireAuthenticatableProfile(profile.id);

    await this.interactions.patch(id, {
      profileId: full.id,
      authTime: Math.floor(Date.now() / 1000),
      pendingPhone: undefined,
      otpAttempts: 0,
    });

    // Mint a normal Rabotka session too. The user has just done exactly what
    // Rabotka's own login asks for, so refusing them a session would mean
    // making them do it again on the next partner site — the single-sign-on
    // half of this feature. `setAuthCookie` is the one definition of the
    // cookie's attributes, and every login path has to use it or sessions
    // created here would behave differently from sessions created elsewhere.
    const { token } = this.auth.issueProfileSession(full.id);
    setAuthCookie(res, this.config, token);

    return this.authorization.consentContext(id);
  }

  /** Approve or refuse. Both end at the partner's redirect URI. */
  @Public()
  @Post('interaction/:id/consent')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async consent(@Param('id') id: string, @Body() dto: ConsentDecisionDto) {
    return dto.approve
      ? this.authorization.approve(id)
      : this.authorization.deny(id);
  }

  private async requireAuthenticatableProfile(profileId: string) {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, deleted_at: null },
      select: { id: true, status: true },
    });

    if (!profile || !canAuthenticateToPartner(profile.status)) {
      throw new OAuthError(
        'access_denied',
        'Ce compte ne peut pas être utilisé pour se connecter à une application partenaire.',
        403,
      );
    }

    return profile;
  }

  private frontendUrl(): string {
    return (
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }
}
