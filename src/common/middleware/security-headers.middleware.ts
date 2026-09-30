import type { NextFunction, Request, Response } from 'express';

/**
 * The response headers every reply should carry, set in one place.
 *
 * Written out rather than pulled in from `helmet`: this is an API, so most of
 * what helmet configures (a content security policy for pages, cross-origin
 * embedder rules) either does not apply or would need turning off again, and
 * what is left is these four lines.
 *
 * - `nosniff` — a browser must not reinterpret a response as another type. We
 *   relay stored files and user uploads; none of them may become a script
 *   because a browser guessed.
 * - `X-Frame-Options: DENY` — nothing the API serves is meant to be framed, and
 *   a framed response is what clickjacking is built from.
 * - `Referrer-Policy: no-referrer` — API urls carry one-time tokens (login
 *   links, payment tokens); they must not travel on to the next site.
 * - `Strict-Transport-Security` — production only, because it tells the browser
 *   to refuse plain http for this host from now on, which is wrong for a dev
 *   machine reached over http.
 */
export function securityHeaders(isProduction: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (isProduction) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=15552000; includeSubDomains',
      );
    }
    next();
  };
}
