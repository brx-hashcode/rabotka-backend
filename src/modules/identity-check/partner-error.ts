import { HttpException } from '@nestjs/common';

export type PartnerErrorCode =
  | 'identity_check_not_enabled'
  | 'invalid_phone'
  | 'not_found'
  | 'not_pending'
  | 'rate_limited'
  | 'idempotency_conflict';

/**
 * An error in the same `{ error, error_description }` shape the OIDC endpoints
 * return, so a partner's client handles one format for everything Rabotka
 * sends back.
 */
export function partnerError(
  status: number,
  code: PartnerErrorCode,
  description: string,
): HttpException {
  return new HttpException(
    { error: code, error_description: description },
    status,
  );
}
