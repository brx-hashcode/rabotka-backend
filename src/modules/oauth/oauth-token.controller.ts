import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { OAuthError } from './oauth-error';
import { OAuthExceptionFilter } from './filters/oauth-exception.filter';
import { OAuthAppService } from './services/oauth-app.service';
import { OAuthCodeService } from './services/oauth-code.service';
import { OAuthTokenService } from './services/oauth-token.service';
import { OAuthSandboxService } from './services/oauth-sandbox.service';
import { RevokeTokenDto, TokenRequestDto } from './dto';
import { verifyCodeChallenge } from './utils/pkce.util';
import { buildClaims } from './utils/claims.util';
import { ACCESS_TOKEN_TTL_SECONDS } from './oauth.constants';

/**
 * The server-to-server half of "Login with Rabotka".
 *
 * Nothing here is ever called by a browser: a partner's backend redeems the
 * code, and a partner's backend reads `/userinfo`. That is why these routes are
 * in the CSRF skip list — they authenticate with client credentials or a bearer
 * token, neither of which a browser attaches ambiently, so there is no CSRF to
 * protect against and a CSRF check would simply reject every legitimate call.
 */
@ApiTags('OpenID Connect')
@Controller('oauth')
@UseFilters(OAuthExceptionFilter)
export class OAuthTokenController {
  constructor(
    private readonly apps: OAuthAppService,
    private readonly codes: OAuthCodeService,
    private readonly tokens: OAuthTokenService,
    private readonly prisma: PrismaService,
    private readonly sandbox: OAuthSandboxService,
  ) {}

  @Public()
  @Post('token')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  // Tokens must never touch a shared cache, and RFC 6749 §5.1 requires both.
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: 'Exchange an authorization code for tokens' })
  async token(@Body() dto: TokenRequestDto, @Req() req: Request) {
    const credentials = readClientCredentials(req, dto);
    const app = await this.apps.authenticateClient(
      credentials.clientId,
      credentials.clientSecret,
    );

    // Consumed before anything is validated, so a wrong verifier cannot be
    // retried. See the note on `OAuthCodeService.consume`.
    const grant = await this.codes.consume(dto.code);

    const invalidGrant = new OAuthError(
      'invalid_grant',
      'The authorization code is invalid, expired, or has already been used.',
      400,
    );

    if (!grant) throw invalidGrant;

    // The code belongs to whoever it was minted for. Without this check, app B
    // holding a code issued to app A could redeem it and receive an identity it
    // was never granted.
    if (grant.clientId !== app.client_id) throw invalidGrant;

    // RFC 6749 §4.1.3: the redirect_uri presented here must be the one the code
    // was minted with, not merely one the app has registered.
    if (grant.redirectUri !== dto.redirect_uri) throw invalidGrant;

    if (!verifyCodeChallenge(dto.code_verifier, grant.codeChallenge)) {
      throw invalidGrant;
    }

    const sandboxSubject = this.sandbox.isSandboxSubject(grant.profileId);

    // The second agreement check, after the one in `approve`. This is the one
    // that catches an admin flipping `is_sandbox` in the sixty seconds between
    // consent and redemption: without it a sandbox subject under a now-real app
    // would be looked up in `profiles` with an id that is not a uuid, and the
    // partner would see a 500 instead of `invalid_grant`.
    if (sandboxSubject !== this.sandbox.isSandboxApp(app)) throw invalidGrant;

    let authorization: { id: string; pairwise_sub: string };

    if (sandboxSubject) {
      const synthetic = this.sandbox.authorizationFor(
        grant.appId,
        grant.profileId,
      );
      if (!synthetic) throw invalidGrant;
      authorization = synthetic;
    } else {
      const row = await this.prisma.oAuthAuthorization.findUnique({
        where: {
          idx_oauth_authorization_app_profile: {
            app_id: grant.appId,
            profile_id: grant.profileId,
          },
        },
        select: { id: true, pairwise_sub: true, revoked_at: true },
      });

      // Revoked between consent and redemption. A sixty-second window, but the
      // check costs one indexed read and the alternative is honouring a grant
      // the user just withdrew.
      if (!row || row.revoked_at !== null) throw invalidGrant;

      authorization = row;
    }

    const profile = await this.tokens.loadClaimSource(grant.profileId);
    if (!profile) throw invalidGrant;

    const claims = buildClaims(
      profile,
      grant.scopes,
      authorization.pairwise_sub,
    );

    const idToken = await this.tokens.signIdToken({
      claims,
      clientId: app.client_id,
      nonce: grant.nonce,
      authTime: grant.authTime,
    });

    const accessToken = await this.tokens.mintAccessToken({
      authorizationId: authorization.id,
      profileId: grant.profileId,
      clientId: app.client_id,
      scopes: grant.scopes,
    });

    // Fire-and-forget: a failure to stamp "last used" must not fail a login.
    // Skipped for sandbox, where there is no row to stamp.
    if (!sandboxSubject) {
      this.prisma.oAuthAuthorization
        .update({
          where: { id: authorization.id },
          data: { last_used_at: new Date() },
        })
        .catch(() => undefined);
    }

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      id_token: idToken,
      scope: grant.scopes.join(' '),
    };
  }

  @Public()
  @Get('userinfo')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Claims for the user behind an access token' })
  async userinfo(@Req() req: Request) {
    const header = req.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new OAuthError(
        'invalid_token',
        'A Bearer access token is required.',
        401,
      );
    }

    return this.tokens.resolveUserinfo(header.slice('Bearer '.length).trim());
  }

  /**
   * RFC 7009 token revocation.
   *
   * Answers 200 whether or not the token existed, which the RFC requires: a
   * client cannot be expected to know whether its token already expired, and
   * distinguishing the two cases would turn this into an oracle for testing
   * whether a stolen token is still live.
   */
  @Public()
  @Post('revoke')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async revoke(@Body() dto: RevokeTokenDto, @Req() req: Request) {
    const credentials = readClientCredentials(req, dto);
    await this.apps.authenticateClient(
      credentials.clientId,
      credentials.clientSecret,
    );

    await this.tokens.revokeAccessToken(dto.token);
    return {};
  }
}

/**
 * Client credentials from either place the spec allows.
 *
 * HTTP Basic (`client_secret_basic`) is what RFC 6749 §2.3.1 says clients SHOULD
 * use and what most libraries default to; the form body (`client_secret_post`)
 * is what the rest send. Supporting only one would break half of all
 * integrations for no gain, so both are read here and nowhere else.
 */
function readClientCredentials(
  req: Request,
  body: { client_id?: string; client_secret?: string },
): { clientId: string; clientSecret: string } {
  const header = req.headers.authorization;

  if (typeof header === 'string' && header.startsWith('Basic ')) {
    const decoded = Buffer.from(
      header.slice('Basic '.length).trim(),
      'base64',
    ).toString('utf8');

    // Split on the FIRST colon only: a secret is base64url and cannot contain
    // one, but a split-on-all would silently truncate any future secret format
    // that could.
    const separator = decoded.indexOf(':');
    if (separator > 0) {
      return {
        // Both halves are percent-encoded per RFC 6749 §2.3.1.
        clientId: safeDecode(decoded.slice(0, separator)),
        clientSecret: safeDecode(decoded.slice(separator + 1)),
      };
    }
  }

  return {
    clientId: body.client_id ?? '',
    clientSecret: body.client_secret ?? '',
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not worth a 500; it will simply fail to match.
    return value;
  }
}
