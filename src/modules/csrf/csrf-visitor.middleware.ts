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
  res.cookie(CSRF_VISITOR_COOKIE, visitorId, {
    sameSite: secureCookies ? 'none' : 'lax',
    path: '/',
    secure: secureCookies,
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 365,
  });

  next();
}
