import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { LogModule } from '../log/log.module';
import { OAuthDiscoveryController } from './oauth-discovery.controller';
import { OAuthAuthorizeController } from './oauth-authorize.controller';
import { OAuthTokenController } from './oauth-token.controller';
import { AdminOAuthAppController } from './admin-oauth-app.controller';
import { OAuthAppService } from './services/oauth-app.service';
import { OAuthCodeService } from './services/oauth-code.service';
import { OAuthInteractionService } from './services/oauth-interaction.service';
import { OAuthTokenService } from './services/oauth-token.service';
import { OAuthAuthorizationService } from './services/oauth-authorization.service';
import { OAuthSandboxService } from './services/oauth-sandbox.service';
import { OidcKeyService } from './services/oidc-key.service';

/**
 * "Login with Rabotka" — Rabotka as an OpenID Connect provider.
 *
 * `PrismaModule` and the Redis module are both `@Global`, so neither is
 * imported here. `AuthModule` is, because this module reuses the existing OTP
 * send/verify and session minting rather than growing a second copy of either:
 * a partner login and a Rabotka login must be the same act, or the
 * `phone_number_verified` claim means two different things depending on which
 * door the user came through.
 */
@Module({
  imports: [ConfigModule, AuthModule, LogModule],
  controllers: [
    OAuthDiscoveryController,
    OAuthAuthorizeController,
    OAuthTokenController,
    AdminOAuthAppController,
  ],
  providers: [
    OidcKeyService,
    OAuthAppService,
    OAuthCodeService,
    OAuthInteractionService,
    OAuthTokenService,
    OAuthAuthorizationService,
    OAuthSandboxService,
  ],
  // The identity-check API authenticates the same apps, signs its webhooks
  // with the same key, and honours the same sandbox.
  exports: [
    OAuthAppService,
    OidcKeyService,
    OAuthTokenService,
    OAuthSandboxService,
  ],
})
export class OAuthModule {}
