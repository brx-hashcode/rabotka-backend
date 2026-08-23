import { Logger } from '@nestjs/common';

const logger = new Logger('VovaProjections');

export type Audience = 'owner' | 'public';

export interface Projection {
  owner: readonly string[];
  public: readonly string[];
}

export const NEVER_EXPOSE = new Set<string>([
  'phone',
  'phone_number',
  'whatsapp',
  'whatsapp_number',
  'email',
  'address',
  'latitude',
  'longitude',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'payment_link',
  'otp',
  'code',
  'national_id',
  'document_url',
  'file_url',
  'kyc_document',
  'kyc_documents',
  'kyc_verification_images',
  'verification_images',
  'selfie_url',
  // `suspension_reason` and `rejection_reason` used to sit here, and it was a
  // mistake of category. Everything else on this list is a CREDENTIAL or a
  // THIRD PARTY's data — an OTP, a national id, a document URL, someone's
  // phone. Those two are the account owner's own information about their own
  // account, and the user has already received the exact text: it fills {{2}}
  // of the suspension and refusal templates the moment an admin decides.
  //
  // Blocking them did not protect anything. It only stopped the assistant
  // repeating what WhatsApp had already delivered, which is precisely the
  // question those users come back to ask. `PROFILE_STATE` scopes them to the
  // `owner` audience and `public` is empty, so no other user can reach them.
  //
  // Note `kyc_verification_note` — another admin-typed field — was never on
  // this list, which is how inconsistent the boundary had become.
]);

export function isNeverExpose(key: string): boolean {
  return NEVER_EXPOSE.has(key.toLowerCase());
}

export function project<T extends Record<string, unknown>>(
  raw: T | null | undefined,
  projection: Projection,
  audience: Audience,
  dtoName: string,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;

  const allowed = audience === 'owner' ? projection.owner : projection.public;
  const picked: Record<string, unknown> = {};

  for (const field of allowed) {
    if (!(field in raw)) continue;
    if (isNeverExpose(field)) {
      logger.error(
        `Projection "${dtoName}" allow-lists "${field}", which is never-expose. Dropping it.`,
      );
      continue;
    }
    picked[field] = scrub(raw[field], dtoName, field);
  }

  return picked;
}

/** {@link project} over a list. */
export function projectMany<T extends Record<string, unknown>>(
  rows: readonly T[] | null | undefined,
  projection: Projection,
  audience: Audience,
  dtoName: string,
): Record<string, unknown>[] {
  if (!rows?.length) return [];
  return rows
    .map((row) => project(row, projection, audience, dtoName))
    .filter((row): row is Record<string, unknown> => row !== null);
}

function scrub(value: unknown, dtoName: string, path: string): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => scrub(item, dtoName, `${path}[${i}]`));
  }
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (isNeverExpose(key)) {
      logger.error(
        `Never-expose field "${key}" reached the tool boundary at ${dtoName}.${path} — scrubbed.`,
      );
      continue;
    }
    out[key] = scrub(nested, dtoName, `${path}.${key}`);
  }
  return out;
}
