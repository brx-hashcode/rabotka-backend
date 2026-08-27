import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { OidcKeyService, OIDC_SIGNING_ALG } from './services/oidc-key.service';
import { OAuthTokenService } from './services/oauth-token.service';
import { SUPPORTED_SCOPES } from './oauth.constants';
import { SUPPORTED_CODE_CHALLENGE_METHODS } from './utils/pkce.util';

/**
 * The two documents that make Rabotka discoverable as an identity provider.
 *
 * Both sit at the domain root rather than under `/api/v1`, because RFC 8414
 * fixes their paths relative to the issuer and clients construct them by
 * string concatenation. `main.ts` excludes them from the global prefix; moving
 * them under the prefix would make every off-the-shelf OIDC client fail to
 * bootstrap, which is precisely the compatibility this feature is buying.
 *
 * Both are `@Public()`, both are cacheable, and both are readable by anyone —
 * one is a list of URLs and the other is a set of public keys.
 */
@ApiTags('OpenID Connect')
@Controller('.well-known')
export class OAuthDiscoveryController {
  constructor(
    private readonly keys: OidcKeyService,
    private readonly tokens: OAuthTokenService,
  ) {}

  @Public()
  @Get('openid-configuration')
  @ApiOperation({
    summary: 'OpenID Provider metadata',
    description:
      'Point any OIDC client library at this URL and it configures itself.',
  })
  // Cached for an hour: it changes only on deploy, and every partner client
  // fetches it on boot. `*` because partner backends and browser-based clients
  // both read it and there is nothing here worth protecting.
  @Header('Cache-Control', 'public, max-age=3600')
  @Header('Access-Control-Allow-Origin', '*')
  discovery() {
    const issuer = this.tokens.issuer();
    const api = `${issuer}/api/v1`;

    return {
      issuer,
      authorization_endpoint: `${api}/oauth/authorize`,
      token_endpoint: `${api}/oauth/token`,
      userinfo_endpoint: `${api}/oauth/userinfo`,
      revocation_endpoint: `${api}/oauth/revoke`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,

      response_types_supported: ['code'],
      // Authorization code only. There is deliberately no refresh_token grant:
      // a partner creates its own user record and its own session from the ID
      // token, so a long-lived credential against Rabotka would have nothing to
      // spend itself on and everything to lose if leaked. Stated here rather
      // than merely omitted so the absence reads as a decision.
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['pairwise'],
      id_token_signing_alg_values_supported: [OIDC_SIGNING_ALG],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
      code_challenge_methods_supported: [...SUPPORTED_CODE_CHALLENGE_METHODS],
      // Advertised so a client library refuses to even start a non-PKCE flow,
      // rather than discovering at /authorize that we require it.
      require_pushed_authorization_requests: false,
      scopes_supported: [...SUPPORTED_SCOPES],
      claims_supported: [
        'sub',
        'iss',
        'aud',
        'exp',
        'iat',
        'auth_time',
        'nonce',
        'name',
        'given_name',
        'family_name',
        'picture',
        'phone_number',
        'phone_number_verified',
        'email',
        'email_verified',
        'rabotka_verified',
        'rabotka_verified_at',
        'rabotka_account_status',
        'city',
        'country_code',
      ],
      claims_parameter_supported: false,
      request_parameter_supported: false,
      service_documentation: `${issuer.replace('api.', '')}/developers/api-documentation`,
      ui_locales_supported: ['fr'],
    };
  }

  @Public()
  @Get('jwks.json')
  @ApiExcludeEndpoint()
  @Header('Cache-Control', 'public, max-age=3600')
  @Header('Access-Control-Allow-Origin', '*')
  jwks() {
    return this.keys.jwks();
  }
}
