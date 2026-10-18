import type { NextFunction, Request, Response } from 'express';
import { isCsrfExemptPath } from './csrf-exempt';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `ALLOW_ORIGINS` as a list, the one parsing both CORS and the origin check
 * use — if they ever disagreed, the check could refuse an origin CORS lets in.
 */
export function parseAllowOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CSRF protection by origin.
 *
 * The session cookie is `SameSite=None` in production (the WhatsApp WebView
 * arrives cross-site), so the browser sends it on a POST from ANY site — that
 * is what CSRF is, and it still needs stopping. This used to be a double-submit
 * token (`csrf-csrf`) bound to a visitor cookie, and it failed real users: an
 * in-app WebView or ITP that dropped either cookie, or the page loaded over
 * http (http→https is cross-site, so the `Lax` visitor cookie never came back),
 * and every POST answered "Invalid CSRF token" — the retry fetched a token
 * that was broken the same way.
 *
 * This holds no state at all. The browser itself sets `Origin` on a
 * cross-origin request and a page cannot forge or omit it, so a state-changing
 * request is refused only when it names an origin that is not ours. That list
 * is the one CORS uses, so an origin refused here is one whose page could not
 * have used the API anyway: the check adds no way for a real user to fail.
 *
 * - Safe methods, Bearer requests (no ambient credential to abuse) and the
 *   routes in `csrf-exempt.ts` are not checked.
 * - `Referer` is the fallback when `Origin` is missing.
 * - Neither header: let through. Every browser sends `Origin` on a cross-origin
 *   fetch or form POST, so its absence means a non-browser client — the mobile
 *   app, a script — which is not riding anyone's cookie.
 * - `Origin: null` (sandboxed frames, opaque redirects) is refused: an attacker
 *   can produce it on demand.
 */
export function originCheck(allowedOrigins: readonly string[]) {
  const allowed = new Set(
    allowedOrigins.map(originOf).filter((o): o is string => o !== null),
  );

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const isBearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ');
    if (isBearer || isCsrfExemptPath(req.originalUrl ?? req.url ?? '')) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (!origin && !referer) {
      next();
      return;
    }

    const caller = origin ? originOf(origin) : originOf(referer ?? '');
    if (caller !== null && allowed.has(caller)) {
      next();
      return;
    }

    res.status(403).json({ statusCode: 403, message: 'Origin not allowed' });
  };
}

/** `scheme://host[:port]`, lower-cased; null for `null` or anything unparsable. */
function originOf(value: string): string | null {
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
