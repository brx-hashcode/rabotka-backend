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
  'suspension_reason',
  'rejection_reason',
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
