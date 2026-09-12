import { createHash, randomBytes } from 'node:crypto';
import {
  isRegisteredRedirectUri,
  validateRedirectUriForRegistration,
} from '../utils/redirect-uri.util';
import { isValidCodeChallenge, verifyCodeChallenge } from '../utils/pkce.util';
import {
  clientSecretMatches,
  derivePairwiseSub,
  generateClientSecret,
  hashClientSecret,
} from '../utils/client-credentials.util';
import { buildClaims, canAuthenticateToPartner } from '../utils/claims.util';
import { AccountStatus, VerificationStatus } from '@prisma/client';

/**
 * These are the checks that stand between a partner integration and an account
 * takeover. Each test below names the attack it exists to stop, because a
 * failing assertion here is not a regression in behaviour — it is a live
 * vulnerability, and whoever is looking at the red test needs to know that.
 */
describe('redirect_uri matching', () => {
  const registered = ['https://partner.com/callback'];

  it('accepts only the exact registered string', () => {
    expect(
      isRegisteredRedirectUri('https://partner.com/callback', registered),
    ).toBe(true);
  });

  it.each([
    // Suffix: the classic prefix-match bypass — an attacker registers a
    // lookalike domain that starts with the real one.
    ['https://partner.com/callback.evil.com', 'suffixed host'],
    ['https://partner.com/callback/../../evil', 'path traversal'],
    ['https://partner.com/callback?next=https://evil.com', 'added query'],
    ['https://partner.com/callback/', 'trailing slash'],
    ['https://PARTNER.com/callback', 'different case'],
    ['http://partner.com/callback', 'downgraded scheme'],
    ['https://evil.com/callback', 'different host'],
    ['', 'empty'],
  ])('rejects %s (%s)', (candidate) => {
    expect(isRegisteredRedirectUri(candidate, registered)).toBe(false);
  });
});

describe('redirect_uri registration', () => {
  it('accepts https', () => {
    expect(
      validateRedirectUriForRegistration('https://partner.com/cb'),
    ).toBeNull();
  });

  it('accepts http on loopback, for local development', () => {
    expect(
      validateRedirectUriForRegistration('http://localhost:8787/cb'),
    ).toBeNull();
  });

  it('refuses http on a public host', () => {
    expect(validateRedirectUriForRegistration('http://partner.com/cb')).toMatch(
      /HTTPS/,
    );
  });

  it('refuses a wildcard, which callers may assume is supported', () => {
    expect(
      validateRedirectUriForRegistration('https://*.partner.com/cb'),
    ).toBeTruthy();
  });

  it('refuses a fragment, which the browser never sends back', () => {
    expect(
      validateRedirectUriForRegistration('https://partner.com/cb#x'),
    ).toBeTruthy();
  });
});

describe('PKCE', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256')
    .update(verifier, 'ascii')
    .digest('base64url');

  it('accepts the verifier that produced the challenge', () => {
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });

  it('rejects any other verifier — this is what makes a stolen code useless', () => {
    const other = randomBytes(32).toString('base64url');
    expect(verifyCodeChallenge(other, challenge)).toBe(false);
  });

  it('rejects a verifier shorter than RFC 7636 allows', () => {
    expect(verifyCodeChallenge('too-short', challenge)).toBe(false);
  });

  it('rejects a raw hex challenge — a common client-side encoding mistake', () => {
    const hex = createHash('sha256').update(verifier, 'ascii').digest('hex');
    expect(isValidCodeChallenge(hex)).toBe(false);
  });

  it('accepts a correctly encoded challenge', () => {
    expect(isValidCodeChallenge(challenge)).toBe(true);
  });
});

describe('client secrets', () => {
  it('round-trips a generated secret', () => {
    const secret = generateClientSecret();
    expect(clientSecretMatches(secret, hashClientSecret(secret))).toBe(true);
  });

  it('rejects a near-miss', () => {
    const secret = generateClientSecret();
    const hash = hashClientSecret(secret);
    expect(clientSecretMatches(`${secret}x`, hash)).toBe(false);
    expect(clientSecretMatches(secret.slice(0, -1), hash)).toBe(false);
  });

  it('rejects an empty secret and a corrupt stored hash without throwing', () => {
    expect(clientSecretMatches('', hashClientSecret('x'))).toBe(false);
    expect(clientSecretMatches('x', 'not-hex')).toBe(false);
  });

  it('carries a greppable prefix so a leaked secret can be scanned for', () => {
    expect(generateClientSecret().startsWith('rbk_sk_')).toBe(true);
  });
});

describe('pairwise subject', () => {
  const salt = 'test-salt';

  it('is stable for the same app and profile', () => {
    expect(derivePairwiseSub('app-1', 'profile-1', salt)).toBe(
      derivePairwiseSub('app-1', 'profile-1', salt),
    );
  });

  it('differs across apps, so two partners cannot correlate a shared user', () => {
    expect(derivePairwiseSub('app-1', 'profile-1', salt)).not.toBe(
      derivePairwiseSub('app-2', 'profile-1', salt),
    );
  });

  it('differs across profiles within one app', () => {
    expect(derivePairwiseSub('app-1', 'profile-1', salt)).not.toBe(
      derivePairwiseSub('app-1', 'profile-2', salt),
    );
  });

  it('depends on the salt, which is why it must never be rotated', () => {
    expect(derivePairwiseSub('app-1', 'profile-1', 'a')).not.toBe(
      derivePairwiseSub('app-1', 'profile-1', 'b'),
    );
  });
});

describe('claims', () => {
  const profile = {
    id: 'p1',
    first_name: 'Amina',
    last_name: 'Nkemdirim',
    phone: '+237690000000',
    email: 'amina@example.com',
    avatar_url: 'https://cdn/a.jpg',
    city: 'Douala',
    country_code: 'CM',
    status: AccountStatus.ACTIVE,
    verification_status: VerificationStatus.VERIFIED,
    verified_at: new Date('2026-01-15T10:00:00Z'),
  };

  it('emits nothing but sub for the bare openid scope', () => {
    expect(buildClaims(profile, ['openid'], 'sub-1')).toEqual({ sub: 'sub-1' });
  });

  it('never emits a claim outside the granted scopes', () => {
    const claims = buildClaims(profile, ['openid', 'profile'], 'sub-1');
    expect(claims).not.toHaveProperty('phone_number');
    expect(claims).not.toHaveProperty('email');
    expect(claims).not.toHaveProperty('rabotka_verified');
    expect(claims).not.toHaveProperty('city');
  });

  it('reports phone_number_verified, which the OTP is what establishes', () => {
    const claims = buildClaims(profile, ['openid', 'phone'], 'sub-1');
    expect(claims.phone_number).toBe('+237690000000');
    expect(claims.phone_number_verified).toBe(true);
  });

  it('reports email_verified false — Rabotka never confirms an address', () => {
    expect(
      buildClaims(profile, ['openid', 'email'], 'sub-1').email_verified,
    ).toBe(false);
  });

  // Email is optional on a profile: most of the informal sector signs up with a
  // phone alone. A relying party branches on a claim's PRESENCE, so emitting
  // `email: null` would read as a broken field rather than an absent one.
  it('omits email and email_verified entirely when the profile has none', () => {
    const claims = buildClaims(
      { ...profile, email: null },
      ['openid', 'email'],
      'sub-1',
    );

    expect(claims).not.toHaveProperty('email');
    expect(claims).not.toHaveProperty('email_verified');
    expect(claims.sub).toBe('sub-1');
  });

  it('reports the KYC verdict, separately from the phone check', () => {
    const claims = buildClaims(
      profile,
      ['openid', 'rabotka:verification'],
      'sub-1',
    );
    expect(claims.rabotka_verified).toBe(true);
    expect(claims.rabotka_verified_at).toBe('2026-01-15T10:00:00.000Z');
  });

  it('reports an unverified profile honestly rather than omitting the claim', () => {
    const claims = buildClaims(
      {
        ...profile,
        verification_status: VerificationStatus.PENDING,
        verified_at: null,
      },
      ['openid', 'rabotka:verification'],
      'sub-1',
    );
    expect(claims.rabotka_verified).toBe(false);
    expect(claims.rabotka_verified_at).toBeNull();
  });
});

describe('who may authenticate to a partner', () => {
  it('refuses a banned account — a ban must not be escapable via a partner', () => {
    expect(canAuthenticateToPartner(AccountStatus.BANNED)).toBe(false);
  });

  it.each([
    AccountStatus.ACTIVE,
    AccountStatus.PENDING_ACTIVATION,
    AccountStatus.SUSPENDED,
  ])(
    'allows %s, letting the partner read the real verification status',
    (status) => {
      expect(canAuthenticateToPartner(status)).toBe(true);
    },
  );
});
