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
        const environment = configService.get<string>(
          'NODE_ENV',
          'development',
        );
        const isProduction = environment === 'production';

        return doubleCsrf({
          getSecret: () => configService.get<string>('CSRF_SECRET') ?? '',
          getSessionIdentifier: (req) => {
            return (
              req.cookies?.[CSRF_VISITOR_COOKIE] ??
              req.csrfSessionId ??
              'anonymous'
            );
          },
          cookieName: isProduction
            ? CSRF_TOKEN_COOKIE_PROD
            : CSRF_TOKEN_COOKIE_DEV,
          cookieOptions: {
            sameSite: 'strict',
            path: '/',
            secure: isProduction,
            httpOnly: true,
          },
          ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
          // Skip CSRF for external webhooks (e.g. Twilio WhatsApp) that cannot send a token
          skipCsrfProtection: (req) => {
            const path =
              (req.route?.path as string | undefined) ?? req.path ?? req.url;
            const full = req.originalUrl ?? req.url ?? path;
            return (
              path === '/api/v1/whatsapp/incoming' ||
              full.startsWith('/api/v1/whatsapp/incoming')
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
