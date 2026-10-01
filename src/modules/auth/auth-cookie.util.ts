import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

/**
 * How long a session lives. Most Rabotka traffic arrives from a WhatsApp link
 * into an in-app WebView that keeps nothing between visits, so a short cookie
 * means re-authenticating constantly; the links themselves stay single-use and
 * 24h, which is what actually bounds the risk.
 */
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * How long an ADMIN session lives, in hours.
 *
 * Admins used to get the same 30 days as a worker opening the app from
 * WhatsApp. The reasons for that length do not apply to them — they sign in on
 * a desktop browser that keeps its cookies — while the cost of a stolen admin
 * cookie is every profile, payment and identity document on the platform for a
 * month. A working day is the default; `ADMIN_SESSION_HOURS` overrides it.
 */
const DEFAULT_ADMIN_SESSION_HOURS = 12;

export function adminSessionHours(config: ConfigService): number {
  const hours = Number(
    config.get<string>('ADMIN_SESSION_HOURS') ?? DEFAULT_ADMIN_SESSION_HOURS,
  );
  return Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_ADMIN_SESSION_HOURS;
}

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
  options: { kind?: 'profile' | 'admin' } = {},
): void {
  const days = Number(
    config.get<string>('AUTH_COOKIE_MAX_AGE_DAYS') ?? DEFAULT_MAX_AGE_DAYS,
  );
  const maxAgeDays =
    Number.isFinite(days) && days > 0 ? days : DEFAULT_MAX_AGE_DAYS;

  // The cookie must not outlive the token in it — see the note on
  // JWT_EXPIRES_IN in auth.module.ts — so an admin's matches the admin token.
  const maxAge =
    options.kind === 'admin'
      ? adminSessionHours(config) * 60 * 60 * 1000
      : maxAgeDays * 24 * 60 * 60 * 1000;

  res.cookie(authCookieName(config), token, {
    ...cookieAttributes(config),
    maxAge,
  });
}

/**
 * The token the browser sent, if any.
 *
 * `cookie-parser` populates `req.cookies` (registered in `main.ts`), so this is
 * only here to keep the cookie's *name* in one place alongside its attributes.
 */
export function readAuthCookie(
  req: Request,
  config: ConfigService,
): string | undefined {
  return req.cookies?.[authCookieName(config)] as string | undefined;
}

/**
 * Drops a session the server has already rejected.
 *
 * The attributes must match `setAuthCookie` byte for byte — a `Set-Cookie` that
 * differs in `path`, `secure` or `sameSite` creates a *second* cookie instead of
 * removing the first, and the browser keeps resending the dead one forever.
 */
export function clearAuthCookie(res: Response, config: ConfigService): void {
  res.clearCookie(authCookieName(config), cookieAttributes(config));
}

function authCookieName(config: ConfigService): string {
  const cookieName = config.get<string>('AUTH_COOKIE_NAME');

  if (!cookieName) {
    throw new Error('AUTH_COOKIE_NAME is not set');
  }

  return cookieName;
}

function cookieAttributes(config: ConfigService): CookieOptions {
  const isProduction = config.get<string>('NODE_ENV') === 'production';

  return {
    httpOnly: true,
    secure: isProduction,
    // The WhatsApp WebView arrives cross-site, so production needs None.
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}
