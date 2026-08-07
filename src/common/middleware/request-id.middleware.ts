import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

/* eslint-disable @typescript-eslint/no-namespace -- Express Request augmentation requires namespace */
declare global {
  namespace Express {
    interface Request {
      /** Correlates every interaction event produced while serving this request. */
      requestId?: string;
    }
  }
}
/* eslint-enable @typescript-eslint/no-namespace */

/** Echoed back so a client can correlate its own telemetry with ours. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Gives every request a stable id, so a ranked feed and the taps that follow it
 * can be tied together.
 *
 * `interaction_events` has carried `request_id` and `position` columns — and an
 * index on `request_id` — since the table was created, with a schema comment
 * saying they *"tie IMPRESSION_BATCH ⇄ VIEW ⇄ APPLY back to one ranked
 * response, so CTR and position bias are computable."* Nothing ever populated
 * them, so the index was on a wholly NULL column and neither number could be
 * computed. This is the missing half.
 *
 * Honours an inbound `x-request-id` so a caller that already has a correlation
 * id keeps it, and echoes the value on the response.
 *
 * Distinct from `csrfSessionId`, which is a year-long visitor cookie — that is a
 * session identity, not a request one, and it is only ever assigned on a
 * visitor's very first request.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header(REQUEST_ID_HEADER);
  const requestId =
    inbound && inbound.trim().length > 0 ? inbound.trim() : randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
