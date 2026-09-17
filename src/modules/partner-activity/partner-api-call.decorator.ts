import { SetMetadata } from '@nestjs/common';
import type { PartnerApiCallKind } from '@prisma/client';
import type { Request } from 'express';

export const PARTNER_API_CALL = 'partner-api-call';

/**
 * Marks a handler whose calls are recorded in the partner activity log. Only
 * handlers carrying it are recorded; the interceptor is a no-op elsewhere.
 */
export const PartnerApiCall = (kind: PartnerApiCallKind) =>
  SetMetadata(PARTNER_API_CALL, kind);

/**
 * What the log reads off a request to tell which app made it.
 *
 * `partnerApp` is set by `PartnerClientAuthGuard`; `partnerClientId` by the
 * userinfo handler once the bearer token is resolved. Token and revoke calls
 * carry the client id in their own credentials.
 */
export type PartnerLogRequest = Request & {
  partnerApp?: { id: string };
  partnerClientId?: string;
  partnerCallStartedAt?: number;
};
