import type { ConfigService } from '@nestjs/config';
import {
  OAuthSandboxService,
  SANDBOX_OTP,
} from '../services/oauth-sandbox.service';
import { buildClaims, canAuthenticateToPartner } from '../utils/claims.util';
import { derivePairwiseSub } from '../utils/client-credentials.util';

const SALT = 'pairwise-salt';

const config = {
  get: (key: string) => (key === 'OIDC_PAIRWISE_SALT' ? SALT : undefined),
} as unknown as ConfigService;

const VERIFIED = 'sandbox:verified';
const UNVERIFIED = 'sandbox:unverified';

function service() {
  return new OAuthSandboxService(config);
}

describe('OAuthSandboxService — recognising a sandbox app', () => {
  it.each([
    [{ is_sandbox: true }, true],
    [{ is_sandbox: false }, false],
    // A row selected without the column, or a fixture predating it. "Real" is
    // the safe reading of a missing flag.
    [{}, false],
    [null, false],
    [undefined, false],
  ])('%p → %p', (app, expected) => {
    expect(service().isSandboxApp(app)).toBe(expected);
  });
});

describe('OAuthSandboxService — recognising a sandbox subject', () => {
  /**
   * A PREFIX test, deliberately broader than the ids that actually resolve.
   * Anything sandbox-shaped must be steered away from Prisma even when it is
   * not one of ours, because `profiles.id` is a uuid column and an unknown
   * `sandbox:` id reaching it is a P2023 rather than a clean rejection.
   */
  it.each([
    [VERIFIED, true],
    [UNVERIFIED, true],
    ['sandbox:nobody', true],
    ['sandbox:', true],
    ['b8f1c0de-0000-4000-8000-000000000000', false],
    ['', false],
    ['not-a-sandbox-id', false],
    [null, false],
    [undefined, false],
  ])('%p → %p', (id, expected) => {
    expect(service().isSandboxSubject(id)).toBe(expected);
  });
});

describe('OAuthSandboxService — resolving a phone number', () => {
  it.each([
    ['+242061111111', VERIFIED],
    ['+242061111112', UNVERIFIED],
  ])('resolves %s', (phone, id) => {
    expect(service().findUserByPhone(phone)?.id).toBe(id);
  });

  /**
   * The consent screen sends what the user typed. `AuthService.normalize` only
   * trims and lowercases, so anything with internal spaces has to be handled
   * here or a perfectly reasonable `+242 06 111 1111` falls through to the real
   * path and asks the database about a number that is not in it.
   */
  it.each([
    '  +242061111111  ',
    '+242 06 111 1111',
    '+242\t061111111',
    '+242 061111111',
  ])('tolerates the formatting in %p', (phone) => {
    expect(service().findUserByPhone(phone)?.id).toBe(VERIFIED);
  });

  it.each([
    ['+242061111113', 'a near miss on the last digit'],
    ['+237690000042', 'a real-looking number'],
    ['242061111111', 'the same number without its plus'],
    ['', 'an empty string'],
    ['   ', 'whitespace only'],
  ])('returns null for %p (%s)', (phone) => {
    expect(service().findUserByPhone(phone)).toBeNull();
  });
});

describe('OAuthSandboxService — the fixed OTP', () => {
  it.each([VERIFIED, UNVERIFIED])('accepts %s with the fixed code', (id) => {
    const svc = service();
    const phone = svc.claimSource(id)!.phone;
    expect(svc.verifyOtp(phone, SANDBOX_OTP)?.id).toBe(id);
  });

  it.each(['11111', '1111111', '', '123456', ' 111111 ', 'abcdef'])(
    'rejects %p',
    (otp) => {
      expect(service().verifyOtp('+242061111111', otp)).toBeNull();
    },
  );

  /**
   * Exactly as strict as the real path, which compares bytes in Lua. A sandbox
   * that quietly accepted padding would be more permissive than the thing it
   * stands in for, and a partner would only discover the difference in
   * production.
   */
  it('compares exactly, without trimming', () => {
    expect(service().verifyOtp('+242061111111', ' 111111 ')).toBeNull();
  });

  /**
   * The invariant that makes the fixed code safe: it is only reachable once the
   * number has already been established as a sandbox number, so `111111` is an
   * ordinary wrong code for every real person.
   */
  it('refuses the fixed code for a number that is not a sandbox number', () => {
    expect(service().verifyOtp('+237690000042', SANDBOX_OTP)).toBeNull();
  });
});

describe('OAuthSandboxService — the claim source', () => {
  /**
   * The contract-pinning test. `buildClaims` reads a `ClaimSourceProfile` and
   * cannot tell a synthetic one from a real row — which only holds while these
   * eleven fields are exactly right. A field added to the type without being
   * added here fails to compile; a value changed by accident fails here.
   */
  it('is exactly the verified user', () => {
    expect(service().claimSource(VERIFIED)).toEqual({
      id: VERIFIED,
      first_name: 'Rabotka',
      last_name: 'Sandbox',
      phone: '+242061111111',
      email: 'sandbox-verified@sandbox.rabotka.work',
      avatar_url: null,
      city: 'Brazzaville',
      country_code: 'CG',
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
      verified_at: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('is exactly the unverified user', () => {
    expect(service().claimSource(UNVERIFIED)).toEqual({
      id: UNVERIFIED,
      first_name: 'Rabotka',
      last_name: 'Sandbox',
      phone: '+242061111112',
      email: 'sandbox-unverified@sandbox.rabotka.work',
      avatar_url: null,
      city: 'Brazzaville',
      country_code: 'CG',
      status: 'ACTIVE',
      verification_status: 'PENDING',
      verified_at: null,
    });
  });

  /**
   * `rabotka_verified_at` is emitted to partners. A value built with
   * `new Date()` would move on every login and show up as churn in the record
   * of anyone who stores what they receive.
   */
  it('reports a stable verified_at across calls', () => {
    const svc = service();
    expect(svc.claimSource(VERIFIED)!.verified_at).toEqual(
      svc.claimSource(VERIFIED)!.verified_at,
    );
    expect(svc.claimSource(VERIFIED)!.verified_at?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('both users may authenticate to a partner', () => {
    const svc = service();
    expect(canAuthenticateToPartner(svc.claimSource(VERIFIED)!.status)).toBe(
      true,
    );
    expect(canAuthenticateToPartner(svc.claimSource(UNVERIFIED)!.status)).toBe(
      true,
    );
  });

  it('is frozen, since it is a process-wide singleton', () => {
    expect(Object.isFrozen(service().claimSource(VERIFIED))).toBe(true);
  });
});

describe('OAuthSandboxService — unknown sandbox ids', () => {
  /**
   * Routed away from Prisma by the prefix test, then refused here. Every caller
   * already handles null, so an unrecognised sentinel costs a clean rejection
   * rather than a new error path.
   */
  it.each(['sandbox:nobody', 'sandbox:', 'sandbox:VERIFIED'])(
    'returns null everywhere for %p',
    (id) => {
      const svc = service();
      expect(svc.claimSource(id)).toBeNull();
      expect(svc.consentProfile(id)).toBeNull();
      expect(svc.authorizationFor('app-1', id)).toBeNull();
    },
  );
});

describe('OAuthSandboxService — the consent screen', () => {
  it('masks the phone the same way a real profile is masked', () => {
    expect(service().consentProfile(VERIFIED)).toEqual({
      firstName: 'Rabotka',
      lastName: 'Sandbox',
      phoneHint: '••11',
      avatarUrl: null,
    });
  });

  /**
   * The two users share a display name, so the hint is the only thing on that
   * screen telling a tester which of them they are signing in as.
   */
  it('distinguishes the two users by their hint', () => {
    expect(service().consentProfile(UNVERIFIED)?.phoneHint).toBe('••12');
  });
});

describe('OAuthSandboxService — the synthesised grant', () => {
  it('derives a real pairwise sub', () => {
    expect(service().authorizationFor('app-1', VERIFIED)?.pairwise_sub).toBe(
      derivePairwiseSub('app-1', VERIFIED, SALT),
    );
  });

  it('gives the two users different subs within one app', () => {
    const svc = service();
    expect(svc.authorizationFor('app-1', VERIFIED)?.pairwise_sub).not.toBe(
      svc.authorizationFor('app-1', UNVERIFIED)?.pairwise_sub,
    );
  });

  /**
   * Pairwise holds for sandbox users too, so a partner can genuinely test
   * keying their user table on `sub` — including discovering that the same
   * person looks different to a second application.
   */
  it('gives one user different subs across two apps', () => {
    const svc = service();
    expect(svc.authorizationFor('app-1', VERIFIED)?.pairwise_sub).not.toBe(
      svc.authorizationFor('app-2', VERIFIED)?.pairwise_sub,
    );
  });

  it('refuses to derive a sub from an empty salt', () => {
    const svc = new OAuthSandboxService({
      get: () => undefined,
    } as unknown as ConfigService);

    expect(() => svc.authorizationFor('app-1', VERIFIED)).toThrow(
      'OIDC_PAIRWISE_SALT',
    );
  });
});

describe('OAuthSandboxService — the claims a partner receives', () => {
  const scopes = ['openid', 'profile', 'phone', 'rabotka:verification'];

  /**
   * Run through the REAL `buildClaims`. This is what proves the synthetic
   * source matches `ClaimSourceProfile` in substance and not merely in shape —
   * a wrong field name would surface here as a missing claim.
   */
  it('is a complete claim set for the verified user', () => {
    const svc = service();
    const claims = buildClaims(svc.claimSource(VERIFIED)!, scopes, 'the-sub');

    expect(claims).toMatchObject({
      sub: 'the-sub',
      given_name: 'Rabotka',
      family_name: 'Sandbox',
      name: 'Rabotka Sandbox',
      picture: null,
      phone_number: '+242061111111',
      phone_number_verified: true,
      rabotka_verified: true,
      rabotka_verified_at: '2026-01-01T00:00:00.000Z',
      rabotka_account_status: 'ACTIVE',
    });
  });

  /**
   * The whole reason there are two of them. `phone_number_verified` says a
   * WhatsApp message arrived; `rabotka_verified` is an admin's verdict on an ID
   * document. A partner has to be able to test the false branch, or they will
   * ship having only ever seen the true one.
   */
  it('separates phone verification from KYC for the unverified user', () => {
    const svc = service();
    const claims = buildClaims(svc.claimSource(UNVERIFIED)!, scopes, 'other');

    expect(claims.phone_number_verified).toBe(true);
    expect(claims.rabotka_verified).toBe(false);
    expect(claims.rabotka_verified_at).toBeNull();
  });

  it('still gates claims by scope', () => {
    const svc = service();
    const claims = buildClaims(svc.claimSource(VERIFIED)!, ['openid'], 's');

    expect(claims).toEqual({ sub: 's' });
  });
});

describe('OAuthSandboxService — the admin catalogue', () => {
  it('publishes the code and both users', () => {
    expect(service().catalogue()).toEqual({
      otp: '111111',
      users: [
        {
          phone: '+242061111111',
          name: 'Rabotka Sandbox',
          rabotkaVerified: true,
        },
        {
          phone: '+242061111112',
          name: 'Rabotka Sandbox',
          rabotkaVerified: false,
        },
      ],
    });
  });
});
