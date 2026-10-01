import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { CSRF_VISITOR_COOKIE } from './csrf.constants';

/* eslint-disable @typescript-eslint/no-namespace -- Express Request augmentation requires namespace */
declare global {
  namespace Express {
    interface Request {
      csrfSessionId?: string;
    }
  }
}

export function csrfVisitorMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const existingId = req.cookies?.[CSRF_VISITOR_COOKIE];
  if (existingId) {
    next();
    return;
  }

  const visitorId = randomUUID();
  req.csrfSessionId = visitorId;

  const secureCookies = process.env.SECURE_COOKIES === 'true';
  // Secure in production regardless — see the note in csrf.module.ts.
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(CSRF_VISITOR_COOKIE, visitorId, {
    sameSite: secureCookies ? 'none' : 'lax',
    path: '/',
    secure: isProduction || secureCookies,
    httpOnly: true,
    // Milliseconds — Express's unit. This was written in seconds, so the
    // visitor id meant to last a year expired after about eight and a half
    // hours, and every visitor's CSRF token with it.
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });

  next();
}
