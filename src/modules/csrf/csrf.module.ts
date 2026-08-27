import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { doubleCsrf } from 'csrf-csrf';
import {
  CSRF_UTILITIES,
  CSRF_TOKEN_COOKIE_DEV,
  CSRF_TOKEN_COOKIE_PROD,
  CSRF_VISITOR_COOKIE,
} from './csrf.constants';
import { CsrfController } from './csrf.controller';

@Module({
  imports: [ConfigModule],
  controllers: [CsrfController],
  providers: [
    {
      provide: CSRF_UTILITIES,
      useFactory: (configService: ConfigService) => {
        const isProduction =
          configService.get<string>('NODE_ENV') === 'production';
        const secureCookies =
          configService.get<string>('SECURE_COOKIES') === 'true';

        return doubleCsrf({
          getSecret: () => configService.get<string>('CSRF_SECRET') ?? '',
          getSessionIdentifier: (req) => {
            return (
              req.cookies?.[CSRF_VISITOR_COOKIE] ??
              req.csrfSessionId ??
              'anonymous'
            );
          },
          // Use __Host- prefix only when secure cookies are enabled (HTTPS).
          // The __Host- prefix requires Secure flag + HTTPS; using it over HTTP
          // causes browsers to silently drop the cookie.
          cookieName:
            isProduction && secureCookies
              ? CSRF_TOKEN_COOKIE_PROD
              : CSRF_TOKEN_COOKIE_DEV,
          cookieOptions: {
            sameSite: secureCookies ? 'none' : 'lax',
            path: '/',
            secure: secureCookies,
            httpOnly: true,
          },
          ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
          skipCsrfProtection: (req) => {
            const url: string = req.originalUrl ?? req.url ?? req.path ?? '';
            // CSRF is a cookie-session attack vector. Requests authenticated with
            // a Bearer token (the mobile app) carry no ambient cookie the browser
            // would auto-send, so CSRF does not apply — skip it for them. The web
            // app keeps using cookies and stays protected.
            const authHeader = req.headers?.authorization;
            const isBearer =
              typeof authHeader === 'string' &&
              authHeader.startsWith('Bearer ');
            return (
              isBearer ||
              url.includes('/whatsapp/incoming') ||
              // Meta's webhook. A provider cannot carry a CSRF token, and
              // without this the POST is answered with a JSON 403 by this very
              // middleware — signature verification never runs, and Meta
              // retries against the 403 for days.
              url.includes('/webhooks/whatsapp/') ||
              url.includes('/auth/mobile/') ||
              // The OIDC server-to-server endpoints. A partner's BACKEND calls
              // these, authenticating with HTTP Basic client credentials or a
              // bearer token — neither of which a browser attaches ambiently,
              // so there is no CSRF to protect against. Note that the `isBearer`
              // escape above does NOT cover `/oauth/token`: it authenticates
              // with `Basic`, so without this line every token exchange would
              // be answered with a 403 and no integration would ever complete.
              //
              // Deliberately NOT listed: `/oauth/interaction/*`. Those are
              // called by Rabotka's own consent page, from FRONTEND_URL, with
              // the session cookie attached — exactly the shape CSRF exists for.
              url.includes('/oauth/token') ||
              url.includes('/oauth/revoke') ||
              url.includes('/oauth/userinfo')
            );
          },
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [CSRF_UTILITIES],
})
export class CsrfModule {}
