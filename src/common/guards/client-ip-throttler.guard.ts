import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientIp } from '../utils/request-meta.util';

/**
 * The throttler, counting per client as the audit logs see them
 * (`clientIp`: Cloudflare's own `CF-Connecting-IP`, else the address Express
 * trusts). Counted on `req.ip`, behind the tunnel and the business site's
 * proxy, several people could share one count — and the careers page's
 * apply limit (5 per 10 minutes) refuse real candidates.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(
      clientIp(req as unknown as Request) ?? String(req.ip ?? ''),
    );
  }
}
