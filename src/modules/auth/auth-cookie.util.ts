import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

/**
 * How long a session lives. Most Rabotka traffic arrives from a WhatsApp link
 * into an in-app WebView that keeps nothing between visits, so a short cookie
 * means re-authenticating constantly; the links themselves stay single-use and
 * 24h, which is what actually bounds the risk.
 */
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * The one definition of the session cookie.
 *
 * Every login path — OTP, admin OTP, admin QR, admin TOTP, WhatsApp link,
 * short link — must set byte-identical attributes, or a session created by one
 * behaves differently from another's.
 */
export function setAuthCookie(
  res: Response,
  config: ConfigService,
  token: string,
): void {
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const cookieName = config.get<string>('AUTH_COOKIE_NAME');

  if (!cookieName) {
    throw new Error('AUTH_COOKIE_NAME is not set');
  }

  const days = Number(
    config.get<string>('AUTH_COOKIE_MAX_AGE_DAYS') ?? DEFAULT_MAX_AGE_DAYS,
  );
  const maxAgeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS;

  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: isProduction,
    // The WhatsApp WebView arrives cross-site, so production needs None.
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
