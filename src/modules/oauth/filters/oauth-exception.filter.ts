import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { OAuthError } from '../oauth-error';

/**
 * Renders `OAuthError` the way OAuth clients expect it.
 *
 * Nest's default filter produces `{ statusCode, message, error }`, which no
 * OAuth library on any platform understands — a partner's client would see an
 * opaque failure instead of `invalid_grant` and would have no way to tell
 * "your code is spent" from "our server is down". The wire format below is part
 * of the contract, not a presentation choice.
 *
 * Mounted per-controller rather than globally: every other endpoint in this app
 * genuinely wants Nest's shape, and a global filter for one module's error type
 * is a trap for whoever adds the next module.
 */
@Catch(OAuthError)
export class OAuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('OAuth');

  catch(error: OAuthError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // A redirect URI is present only when it has already been matched against
    // the app's registered list — see `beginAuthorization`. Trusting this field
    // without that guarantee would be the open-redirector bug.
    if (error.redirectUri) {
      const url = new URL(error.redirectUri);
      url.searchParams.set('error', error.code);
      url.searchParams.set('error_description', error.description);
      if (error.state) url.searchParams.set('state', error.state);
      res.redirect(302, url.toString());
      return;
    }

    if (error.status >= 500) {
      this.logger.error(`${error.code}: ${error.description}`);
    } else {
      this.logger.warn(`${error.code}: ${error.description}`);
    }

    // RFC 6750 §3: a 401 from a bearer-protected resource has to say how to
    // authenticate, or a conforming client will not know to retry with a token.
    if (error.status === 401) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="${error.code}", error_description="${error.description.replace(/"/g, "'")}"`,
      );
    }

    // Credentials and codes travel through these endpoints; nothing here may
    // sit in a shared cache.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.status(error.status).json(error.toBody());
  }
}
