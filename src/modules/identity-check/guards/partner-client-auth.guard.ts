import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PartnerApiCallKind } from '@prisma/client';
import type { Request } from 'express';
import { PARTNER_API_CALL } from '../../partner-activity/partner-api-call.decorator';
import { PartnerRequestLogService } from '../../partner-activity/partner-request-log.service';
import {
  OAuthAppService,
  type OAuthAppRow,
} from '../../oauth/services/oauth-app.service';
import { readClientCredentials } from '../../oauth/utils/client-credentials.util';
import { IDENTITY_CHECK_SCOPE } from '../../oauth/oauth.constants';
import { partnerError } from '../partner-error';

export type PartnerRequest = Request & {
  partnerApp: OAuthAppRow;
  partnerCallStartedAt?: number;
};

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
  constructor(
    private readonly apps: OAuthAppService,
    private readonly reflector: Reflector,
    private readonly log: PartnerRequestLogService,
  ) {}

  /**
   * Refusals are recorded here: the log interceptor runs after guards, so it
   * never sees a request this guard turns away.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PartnerRequest>();
    req.partnerCallStartedAt = Date.now();
    try {
      return await this.authorize(req);
    } catch (error) {
      const kind = this.reflector.get<PartnerApiCallKind | undefined>(
        PARTNER_API_CALL,
        context.getHandler(),
      );
      if (kind) {
        this.log.record({
          kind,
          req,
          startedAt: req.partnerCallStartedAt,
          error,
        });
      }
      throw error;
    }
  }

  private async authorize(req: PartnerRequest): Promise<boolean> {
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
