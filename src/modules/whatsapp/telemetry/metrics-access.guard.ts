import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Who may read `/metrics`.
 *
 * It was public: anyone on the internet could read message volumes, error
 * rates, LLM token counts and queue depths off the production API.
 *
 * Two ways in now:
 *
 * - **From inside the network.** A scraper on the same Docker network reaches
 *   the container directly, so its request carries none of the headers the
 *   reverse proxy stamps on everything arriving from outside. That is the usual
 *   Prometheus setup, and it needs no configuration.
 * - **With `METRICS_TOKEN`**, as `Authorization: Bearer <token>`, for a scraper
 *   that has to come through the public hostname.
 *
 * A client cannot fake the first case: it can add forwarding headers, never
 * remove the ones the proxy adds. Everything else gets a 404 rather than a 401,
 * so the route does not advertise itself.
 */
@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (this.hasValidToken(req) || !cameThroughProxy(req)) return true;

    throw new NotFoundException();
  }

  private hasValidToken(req: Request): boolean {
    const expected = this.config.get<string>('METRICS_TOKEN')?.trim();
    if (!expected) return false;

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }

    const presented = Buffer.from(header.slice('Bearer '.length));
    const wanted = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch, which would itself tell the
    // caller the length.
    return (
      presented.length === wanted.length && timingSafeEqual(presented, wanted)
    );
  }
}

function cameThroughProxy(req: Request): boolean {
  return (
    req.headers['x-forwarded-for'] !== undefined ||
    req.headers['x-forwarded-host'] !== undefined ||
    req.headers['x-real-ip'] !== undefined ||
    req.headers.forwarded !== undefined
  );
}
