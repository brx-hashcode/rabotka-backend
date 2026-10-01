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
import { isCsrfExemptPath } from './csrf-exempt';

const CSRF_SECRET_MIN_LENGTH = 32;

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

        // It used to fall back to an empty string, which signs every token
        // with a key anyone can reproduce. A missing secret now stops the
        // boot instead of quietly making the protection decorative.
        const secret = configService.get<string>('CSRF_SECRET')?.trim() ?? '';
        if (secret.length < CSRF_SECRET_MIN_LENGTH) {
          throw new Error(
            `CSRF_SECRET must be set to at least ${CSRF_SECRET_MIN_LENGTH} characters (openssl rand -base64 32)`,
          );
        }

        return doubleCsrf({
          getSecret: () => secret,
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
            // Secure in production whatever SECURE_COOKIES says, exactly as
            // the session cookie already is (auth-cookie.util.ts). The flag
            // was tied to SECURE_COOKIES alone, which no deploy sets, so these
            // cookies went out without it. SECURE_COOKIES still decides the
            // rest — SameSite=None and the __Host- name — so turning this on
            // renames nothing and changes no cross-site behaviour.
            secure: isProduction || secureCookies,
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
            // The exempt routes, and why each is one, are in csrf-exempt.ts.
            // Note the `isBearer` escape does NOT cover `/oauth/token`, which
            // authenticates with `Basic` — that is why it is listed there.
            return isBearer || isCsrfExemptPath(url);
          },
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [CSRF_UTILITIES],
})
export class CsrfModule {}
