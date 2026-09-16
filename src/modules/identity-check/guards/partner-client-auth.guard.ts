import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  OAuthAppService,
  type OAuthAppRow,
} from '../../oauth/services/oauth-app.service';
import { readClientCredentials } from '../../oauth/utils/client-credentials.util';
import { IDENTITY_CHECK_SCOPE } from '../../oauth/oauth.constants';
import { partnerError } from '../partner-error';

export type PartnerRequest = Request & { partnerApp: OAuthAppRow };

/**
 * Authenticates a partner's backend with its client credentials, exactly as
 * `POST /oauth/token` does, and requires the identity-check switch.
 *
 * Authentication failures surface as `invalid_client` through the OAuth
 * exception filter on the controller. The switch is checked after, so an app
 * with the switch off learns that it is off only once it has proved who it is.
 */
@Injectable()
export class PartnerClientAuthGuard implements CanActivate {
  constructor(private readonly apps: OAuthAppService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PartnerRequest>();

    // Body credentials (`client_secret_post`) are not accepted here: the body
    // is the check itself, and HTTP Basic is what every partner already uses
    // against the token endpoint.
    const credentials = readClientCredentials(req, {});
    const app = await this.apps.authenticateClient(
      credentials.clientId,
      credentials.clientSecret,
    );

    if (!app.allowed_scopes.includes(IDENTITY_CHECK_SCOPE)) {
      throw partnerError(
        403,
        'identity_check_not_enabled',
        'Identity checks are not enabled for this application. Contact Rabotka to enable them.',
      );
    }

    req.partnerApp = app;
    return true;
  }
}
