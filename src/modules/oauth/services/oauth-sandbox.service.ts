import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, VerificationStatus } from '@prisma/client';
import { maskPhone, type ClaimSourceProfile } from '../utils/claims.util';
import { derivePairwiseSub } from '../utils/client-credentials.util';
import type { ConsentContext } from './oauth-authorization.service';

/**
 * Marks a subject id as synthetic.
 *
 * Real profile ids are UUIDs, which cannot contain a colon, so no real id can
 * ever collide with one of these — and no synthetic id can ever be mistaken for
 * a real one on the way into a query.
 */
export const SANDBOX_SUBJECT_PREFIX = 'sandbox:';

/**
 * The one code every sandbox login accepts.
 *
 * Published in the developer documentation, which is the point: a partner
 * building an integration should not need a phone in their hand. It is only
 * ever compared inside {@link OAuthSandboxService.verifyOtp}, and only after the
 * number has already been established as a sandbox number.
 */
export const SANDBOX_OTP = '111111';

/**
 * An inert label on the access-token record where a real authorization row id
 * would sit. Nothing ever looks it up — every branch routes on the subject id —
 * but a recognisable constant beats an empty string in a log line.
 */
export const SANDBOX_AUTHORIZATION_ID = 'sandbox:authorization';

/**
 * A sandbox user is exactly what the claim builder reads from a profile, so
 * `buildClaims` cannot tell the difference and needs no branch of its own.
 */
export type SandboxUser = ClaimSourceProfile;

/**
 * The two sandbox identities, in full.
 *
 * They differ in one thing only — `verification_status` — because that is the
 * distinction partners get wrong. `phone_number_verified` says a WhatsApp
 * message arrived; `rabotka_verified` is an admin's verdict after reading
 * government ID and a selfie. A partner who conflates them has bought nothing,
 * and a sandbox that only ever returns `true` would let them ship that mistake.
 *
 * Frozen because they are module-level singletons handed straight to
 * `buildClaims`: a mutation here would be process-wide and would outlive the
 * request that caused it.
 */
const SANDBOX_USERS: readonly SandboxUser[] = Object.freeze([
  Object.freeze({
    id: `${SANDBOX_SUBJECT_PREFIX}verified`,
    first_name: 'Rabotka',
    last_name: 'Sandbox',
    phone: '+242061111111',
    email: 'sandbox-verified@sandbox.rabotka.work',
    avatar_url: null,
    city: 'Brazzaville',
    country_code: 'CG',
    status: AccountStatus.ACTIVE,
    verification_status: VerificationStatus.VERIFIED,
    // A fixed instant, never `new Date()`. `buildClaims` emits this as
    // `rabotka_verified_at`, and a value that moved on every login would show
    // up as churn in the diff of any partner who stores what they receive.
    verified_at: new Date('2026-01-01T00:00:00.000Z'),
  }),
  Object.freeze({
    id: `${SANDBOX_SUBJECT_PREFIX}unverified`,
    first_name: 'Rabotka',
    last_name: 'Sandbox',
    phone: '+242061111112',
    email: 'sandbox-unverified@sandbox.rabotka.work',
    avatar_url: null,
    city: 'Brazzaville',
    country_code: 'CG',
    // ACTIVE, like its verified twin, and deliberately so:
    // `canAuthenticateToPartner` has to pass, and holding
    // `rabotka_account_status` identical across the pair means a partner
    // testing against both is branching purely on `rabotka_verified`.
    status: AccountStatus.ACTIVE,
    verification_status: VerificationStatus.PENDING,
    verified_at: null,
  }),
]);

/**
 * Everything the sandbox knows, in one place.
 *
 * The rest of the module holds no sandbox data at all — it asks this service and
 * branches on the answer. That is what makes the feature auditable: the two
 * identities, the fixed code and the subject prefix are all visible on one
 * screen, and anything not written here cannot be authenticated by a sandbox
 * app.
 *
 * It depends on `ConfigService` and nothing else. With no Prisma and no Redis
 * injected it is structurally incapable of reading or writing state, which is
 * the strongest available statement of "a sandbox login touches no real data".
 */
@Injectable()
export class OAuthSandboxService {
  /** Published to the admin UI so it never hardcodes its own copy. */
  readonly otp = SANDBOX_OTP;

  constructor(private readonly config: ConfigService) {}

  /**
   * Whether an application is a sandbox one.
   *
   * The `?? false` shape tolerates a row selected without the column and a test
   * fixture that predates it: both read as "real", which is the safe answer.
   */
  isSandboxApp(app: { is_sandbox?: boolean } | null | undefined): boolean {
    return app?.is_sandbox === true;
  }

  /**
   * Whether a subject id is synthetic — a PREFIX test, used for routing.
   *
   * Deliberately broader than the set of ids that actually resolve. Anything
   * shaped like a sandbox id is steered away from Prisma here and then refused
   * by the lookups below, which are exact. The alternative — testing exact
   * membership at the routing sites — would let an unrecognised `sandbox:` id
   * reach `profiles.id`, a `uuid` column, and answer with a Prisma P2023 rather
   * than the clean rejection every caller is written to handle.
   */
  isSandboxSubject(profileId: string | null | undefined): profileId is string {
    return (
      typeof profileId === 'string' &&
      profileId.startsWith(SANDBOX_SUBJECT_PREFIX)
    );
  }

  /**
   * The sandbox user for a phone number, or null.
   *
   * Normalises the way `AuthService.normalize` does, plus stripping internal
   * whitespace so `+242 06 111 1111` resolves. Being looser than the real
   * matcher only ever widens what is recognised as a sandbox number, and every
   * caller treats a match as "do not touch the database".
   */
  findUserByPhone(phone: string): SandboxUser | null {
    if (typeof phone !== 'string') return null;
    const normalized = phone.replace(/\s+/g, '').toLowerCase();
    if (normalized.length === 0) return null;
    return SANDBOX_USERS.find((user) => user.phone === normalized) ?? null;
  }

  /**
   * The sandbox user for a phone number and code, or null.
   *
   * The ONLY place `SANDBOX_OTP` is compared, and it is unreachable for a real
   * profile: the number has to resolve to a sandbox user first. `AuthService`
   * is untouched, so `111111` remains an ordinary wrong code everywhere else.
   */
  verifyOtp(phone: string, otp: string): SandboxUser | null {
    const user = this.findUserByPhone(phone);
    if (!user) return null;
    // Exact comparison, no trimming, matching the real path: the Lua script
    // behind `verifyOtpAndGetProfile` compares bytes, and `VerifyInteractionOtpDto`
    // rejects anything that is not exactly six characters before either of them
    // is reached. A sandbox login that accepted ` 111111 ` would be more
    // permissive than the thing it stands in for.
    if (otp !== SANDBOX_OTP) return null;
    return user;
  }

  /** The claim-bearing fields, in the shape `buildClaims` expects. */
  claimSource(profileId: string): ClaimSourceProfile | null {
    return SANDBOX_USERS.find((user) => user.id === profileId) ?? null;
  }

  /** What the consent screen renders for a sandbox user. */
  consentProfile(profileId: string): ConsentContext['profile'] {
    const user = this.claimSource(profileId);
    if (!user) return null;

    return {
      firstName: user.first_name,
      lastName: user.last_name,
      phoneHint: maskPhone(user.phone),
      avatarUrl: user.avatar_url,
    };
  }

  /**
   * The grant a sandbox login stands on, synthesised rather than stored.
   *
   * There is no `OAuthAuthorization` row — `profile_id` is a foreign key into
   * `profiles` and there is nothing to point at — so the two things the token
   * path reads off that row are produced here instead. The `sub` uses the real
   * derivation, so it is genuinely pairwise: two sandbox apps see different
   * subjects for the same user, and the two users differ within one app, which
   * is exactly what a partner needs in order to test keying on `sub`.
   */
  authorizationFor(
    appId: string,
    profileId: string,
  ): { id: string; pairwise_sub: string } | null {
    const user = this.claimSource(profileId);
    if (!user) return null;

    return {
      id: SANDBOX_AUTHORIZATION_ID,
      pairwise_sub: derivePairwiseSub(appId, user.id, this.pairwiseSalt()),
    };
  }

  /** The catalogue the admin UI shows, so it never hardcodes its own copy. */
  catalogue(): {
    otp: string;
    users: { phone: string; name: string; rabotkaVerified: boolean }[];
  } {
    return {
      otp: SANDBOX_OTP,
      users: SANDBOX_USERS.map((user) => ({
        phone: user.phone,
        name: `${user.first_name} ${user.last_name}`,
        rabotkaVerified:
          user.verification_status === VerificationStatus.VERIFIED,
      })),
    };
  }

  private pairwiseSalt(): string {
    const salt = this.config.get<string>('OIDC_PAIRWISE_SALT');
    if (!salt) {
      // Same reasoning as `OAuthAuthorizationService.pairwiseSalt`: deriving
      // from an empty salt would succeed, look correct, and make every
      // partner's subject ids computable by anyone who knows the two ids.
      throw new Error('OIDC_PAIRWISE_SALT is not set');
    }
    return salt;
  }
}
