import { PartnerApiCallKind } from '@prisma/client';
import { maskPhone } from '../oauth/utils/claims.util';

type Summary = Record<string, unknown>;

const MAX_TEXT = 200;

export function summarizeRequest(
  kind: PartnerApiCallKind,
  body: unknown,
  params: Record<string, string | undefined> = {},
): Summary {
  const b = asRecord(body);

  switch (kind) {
    case PartnerApiCallKind.TOKEN:
      return pick({
        grant_type: text(b.grant_type),
        redirect_uri: text(b.redirect_uri),
      });
    case PartnerApiCallKind.REVOKE:
      return pick({ token_type_hint: text(b.token_type_hint) });
    case PartnerApiCallKind.USERINFO:
      return {};
    case PartnerApiCallKind.IDENTITY_CHECK_CREATE:
      return pick({
        phone:
          typeof b.phone === 'string' ? maskPhone(digitsOf(b.phone)) : null,
        fields_sent: Object.keys(b)
          .filter((key) => key !== 'phone' && b[key] != null && b[key] !== '')
          .sort(),
        reference: text(b.reference),
      });
    case PartnerApiCallKind.IDENTITY_CHECK_READ:
      return pick({ check_id: text(params.id) });
  }
}

export function summarizeResponse(
  kind: PartnerApiCallKind,
  body: unknown,
): Summary {
  const b = asRecord(body);

  switch (kind) {
    case PartnerApiCallKind.TOKEN:
      return pick({ scope: text(b.scope), expires_in: b.expires_in });
    case PartnerApiCallKind.USERINFO:
      return { claims: Object.keys(b).sort() };
    case PartnerApiCallKind.REVOKE:
      return {};
    case PartnerApiCallKind.IDENTITY_CHECK_CREATE:
      return pick({ check_id: text(b.id), status: text(b.status) });
    case PartnerApiCallKind.IDENTITY_CHECK_READ:
      return pick({
        status: text(b.status),
        recommendation: text(b.recommendation),
        score: typeof b.score === 'number' ? b.score : null,
      });
  }
}

export function summarizeError(code: string, description: unknown): Summary {
  return pick({ error: code, description: text(description) });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, '');
}

function pick(values: Summary): Summary {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}
