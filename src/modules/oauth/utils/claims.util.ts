import { AccountStatus, VerificationStatus } from '@prisma/client';
import type { SupportedScope } from '../oauth.constants';

/**
 * The columns the claim builder reads. Written out rather than using
 * `Prisma.ProfileGetPayload` so the `select` in the service and the shape here
 * cannot drift apart silently — adding a claim means touching both.
 */
export type ClaimSourceProfile = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  avatar_url: string | null;
  city: string | null;
  country_code: string | null;
  status: AccountStatus;
  verification_status: VerificationStatus;
  verified_at: Date | null;
};

export type OidcClaims = Record<string, string | boolean | number | null>;

/**
 * `+237 6XX XX XX 42` → `••42`. Enough to recognise, not enough to disclose.
 *
 * Lives here rather than beside the consent screen that renders it because the
 * sandbox service needs the same masking for its synthetic users, and importing
 * it from `oauth-authorization.service.ts` would be a cycle.
 */
export function maskPhone(phone: string): string {
  return `••${phone.slice(-2)}`;
}

/**
 * Which account states may authenticate to a partner at all.
 *
 * BANNED is refused: there is no path back for that account, so handing it a
 * fresh identity somewhere else is the one thing a ban is supposed to prevent.
 *
 * SUSPENDED and PENDING_ACTIVATION are allowed through, and this mirrors the
 * reasoning already written out in `auth/whatsapp-login-link.service.ts`
 * (`MINTABLE_STATUSES`): those accounts are real people, the partner learns
 * their true `rabotka_verified` value — which for both of them is almost always
 * `false` — and the partner decides what to do with that. Refusing them here
 * would instead look to the partner like "no such user", which is a lie.
 */
export function canAuthenticateToPartner(status: AccountStatus): boolean {
  return status !== AccountStatus.BANNED;
}

/**
 * The claims a set of granted scopes entitles a partner to see.
 *
 * Scope-gated one group at a time, with no default case: a claim that is not
 * listed under a scope cannot be emitted, so widening what partners receive is
 * always an edit to this function and never a side effect of a `select`
 * somewhere growing a column. The `sub` is passed in rather than derived here
 * because it is stored, not computed — see `OAuthAuthorization.pairwise_sub`.
 */
export function buildClaims(
  profile: ClaimSourceProfile,
  scopes: readonly string[],
  sub: string,
): OidcClaims {
  const granted = new Set(scopes as SupportedScope[]);
  const claims: OidcClaims = { sub };

  if (granted.has('profile')) {
    claims.given_name = profile.first_name;
    claims.family_name = profile.last_name;
    claims.name = `${profile.first_name} ${profile.last_name}`.trim();
    claims.picture = profile.avatar_url;
  }

  if (granted.has('phone')) {
    claims.phone_number = profile.phone;
    // Always true, and true for a specific reason rather than by assumption:
    // reaching this point required an OTP that was delivered to this number
    // over WhatsApp and typed back in. There is no path to a token that skips
    // that — the session-cookie shortcut in `authorize` only reuses a session
    // that was itself established the same way.
    claims.phone_number_verified = true;
  }

  if (granted.has('email')) {
    claims.email = profile.email;
    // Rabotka does not verify email addresses — signup takes one and never
    // sends a confirmation to it. Reporting `false` is the honest answer and
    // stops a partner from treating it as a trusted account key.
    claims.email_verified = false;
  }

  if (granted.has('rabotka:verification')) {
    // The differentiator, and the one claim worth being pedantic about: this is
    // a Rabotka admin's verdict after reading government ID and a selfie. It is
    // NOT `phone_number_verified`, which only says a WhatsApp message arrived.
    // A partner that conflates the two has bought nothing.
    claims.rabotka_verified =
      profile.verification_status === VerificationStatus.VERIFIED;
    claims.rabotka_verified_at = profile.verified_at?.toISOString() ?? null;
    claims.rabotka_account_status = profile.status;
  }

  if (granted.has('rabotka:location')) {
    claims.city = profile.city;
    claims.country_code = profile.country_code;
  }

  return claims;
}
