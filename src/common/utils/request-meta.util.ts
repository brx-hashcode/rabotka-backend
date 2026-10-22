import type { Request } from 'express';

/**
 * The client's address, as recorded in audit logs and click tracking.
 *
 * Never the leftmost `X-Forwarded-For` entry: the client writes that one
 * itself, and Cloudflare appends to it rather than replacing it, so anyone
 * could record any address they liked against their actions (pentest
 * A2-NV03, #879).
 *
 * `CF-Connecting-IP` first: traffic arrives through the Cloudflare tunnel,
 * and Cloudflare sets that header itself, overwriting any value a client
 * sent. Otherwise `req.ip`, which Express derives from the hops it trusts
 * (`trust proxy` in main.ts).
 */
export function clientIp(req: Request): string | undefined {
  const cf = req.headers?.['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return req.ip ?? undefined;
}

export function extractRequestMeta(req?: Request): {
  ipAddress?: string;
  userAgent?: string;
} {
  if (!req) return {};
  return {
    ipAddress: clientIp(req),
    userAgent: req.get?.('user-agent') ?? undefined,
  };
}
