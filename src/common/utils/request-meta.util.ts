import type { Request } from 'express';

export function extractRequestMeta(req?: Request): {
  ipAddress?: string;
  userAgent?: string;
} {
  if (!req) return {};
  const forwarded = req.headers?.['x-forwarded-for'];
  const ipAddress =
    typeof forwarded === 'string'
      ? (forwarded.split(',')[0]?.trim() ?? req.ip)
      : req.ip;
  return {
    ipAddress: ipAddress ?? undefined,
    userAgent: req.get?.('user-agent') ?? undefined,
  };
}
