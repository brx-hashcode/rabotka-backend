import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importJWK, type JWK } from 'jose';
import { OidcKeyService, OIDC_SIGNING_ALG } from '../services/oidc-key.service';
import { OAuthTokenService } from '../services/oauth-token.service';
import { OAuthSandboxService } from '../services/oauth-sandbox.service';

function makeKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('OidcKeyService', () => {
  const { privateKey, publicKey } = makeKeyPair();

  async function service(extra: Record<string, string | undefined> = {}) {
    const svc = new OidcKeyService(
      configWith({
        OIDC_PRIVATE_KEY: privateKey,
        OIDC_KEY_ID: 'kid-1',
        ...extra,
      }),
    );
    await svc.onModuleInit();
    return svc;
  }

  it('refuses to boot without a key, rather than failing at the first login', async () => {
    const svc = new OidcKeyService(configWith({}));
    await expect(svc.onModuleInit()).rejects.toThrow(/OIDC_PRIVATE_KEY/);
  });

  /**
   * The one that matters.
   *
   * `exportJWK` on a private key returns the private JWK. If the JWKS were
   * built by spreading that object, Rabotka's signing key would be served at a
   * public, CORS-open, hour-cached URL, and anyone could forge an ID token for
   * any user to any partner. This test is the guard on that.
   */
  it('publishes ONLY public key material', async () => {
    const svc = await service();
    const [key] = svc.jwks().keys;

    // Every RSA private component, named individually so a failure says which.
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) {
      expect(key).not.toHaveProperty(secret);
    }

    expect(Object.keys(key).sort()).toEqual(
      ['alg', 'e', 'kid', 'kty', 'n', 'use'].sort(),
    );
  });

  it('stamps kid, alg and use so clients can select the right key', async () => {
    const svc = await service();
    const [key] = svc.jwks().keys;
    expect(key.kid).toBe('kid-1');
    expect(key.alg).toBe(OIDC_SIGNING_ALG);
    expect(key.use).toBe('sig');
  });

  it('publishes a previous public key during a rotation', async () => {
    const other = makeKeyPair();
    const svc = await service({
      OIDC_PUBLIC_KEY_PREVIOUS: other.publicKey,
      OIDC_KEY_ID_PREVIOUS: 'kid-0',
    });

    const keys = svc.jwks().keys;
    expect(keys.map((k) => k.kid)).toEqual(['kid-1', 'kid-0']);
    // The previous entry is public-only too — it came from an SPKI import, but
    // the same allowlist has to apply or rotation becomes the leak instead.
    expect(keys[1]).not.toHaveProperty('d');
  });

  it('boots with one key when the previous one is malformed', async () => {
    const svc = await service({
      OIDC_PUBLIC_KEY_PREVIOUS: 'not-a-pem',
      OIDC_KEY_ID_PREVIOUS: 'kid-0',
    });
    expect(svc.jwks().keys).toHaveLength(1);
  });

  it('accepts a base64-encoded PEM, which is what survives env editors', async () => {
    const svc = new OidcKeyService(
      configWith({
        OIDC_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
        OIDC_KEY_ID: 'kid-1',
      }),
    );
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  /**
   * End-to-end proof that the published JWKS actually verifies a real token —
   * i.e. that a partner who fetches `/.well-known/jwks.json` can do their job.
   * A JWKS that is public-only but wrong would pass every test above.
   */
  it('signs an ID token that verifies against the published JWKS', async () => {
    const keys = await service();
    const tokens = new OAuthTokenService(
      {} as never,
      {} as never,
      configWith({ OIDC_ISSUER: 'https://api.rabotka.work/' }),
      keys,
      new OAuthSandboxService(
        configWith({ OIDC_PAIRWISE_SALT: 'salt' }) as never,
      ),
    );

    const jwt = await tokens.signIdToken({
      claims: { sub: 'pairwise-sub-1', phone_number_verified: true },
      clientId: 'rbk_abc',
      nonce: 'n-1',
      authTime: 1_700_000_000,
    });

    const publicJwk = keys.jwks().keys[0];
    const { payload, protectedHeader } = await jwtVerify(
      jwt,
      await importJWK(publicJwk, OIDC_SIGNING_ALG),
      // The issuer is asserted without its trailing slash: clients compare
      // `iss` byte-for-byte against the discovery document, so the
      // normalisation in `issuer()` is part of the contract.
      { issuer: 'https://api.rabotka.work', audience: 'rbk_abc' },
    );

    expect(protectedHeader.alg).toBe(OIDC_SIGNING_ALG);
    expect(protectedHeader.kid).toBe('kid-1');
    expect(payload.sub).toBe('pairwise-sub-1');
    expect(payload.nonce).toBe('n-1');
    expect(payload.auth_time).toBe(1_700_000_000);
    expect(payload.phone_number_verified).toBe(true);
  });
});

/**
 * `resolveUserinfo` is the only place a token is re-checked against live state.
 * Expiry alone is not enough: consent can be withdrawn, an app suspended, or a
 * profile removed on a different timescale than an hour.
 */
describe('OAuthTokenService.resolveUserinfo', () => {
  const CLAIM_PROFILE = {
    id: 'p-1',
    first_name: 'Amina',
    last_name: 'N',
    phone: '+237690000000',
    email: 'a@example.com',
    avatar_url: null,
    city: 'Douala',
    country_code: 'CM',
    status: 'ACTIVE',
    verification_status: 'VERIFIED',
    verified_at: new Date('2026-01-15T10:00:00Z'),
  };

  function build(record: unknown, authorization: unknown) {
    const store = new Map<string, string>();
    if (record) store.set('rabotka:dev:oauth:at:tok', JSON.stringify(record));

    // Not `async`: nothing here awaits, and the callers only need a thenable.
    const redis = {
      get: (key: string) => Promise.resolve(store.get(key) ?? null),
      del: (key: string) => Promise.resolve(store.delete(key) ? 1 : 0),
      set: () => Promise.resolve('OK'),
    } as never;

    const prisma = {
      oAuthAuthorization: {
        findUnique: jest.fn().mockResolvedValue(authorization),
      },
    } as never;

    const config = { get: () => 'https://api.rabotka.work' } as never;
    return {
      service: new OAuthTokenService(
        redis,
        prisma,
        config,
        {} as never,
        new OAuthSandboxService(config),
      ),
      store,
    };
  }

  const RECORD = {
    authorizationId: 'auth-1',
    profileId: 'p-1',
    clientId: 'rbk_abc',
    scopes: ['openid', 'profile', 'phone'],
  };

  const LIVE = {
    revoked_at: null,
    pairwise_sub: 'sub-1',
    app: { status: 'ACTIVE', deleted_at: null },
    profile: CLAIM_PROFILE,
  };

  it('returns the claims the granted scopes allow', async () => {
    const { service } = build(RECORD, LIVE);
    const claims = await service.resolveUserinfo('tok');

    expect(claims.sub).toBe('sub-1');
    expect(claims.given_name).toBe('Amina');
    expect(claims.phone_number_verified).toBe(true);
    // Not granted, so absent.
    expect(claims).not.toHaveProperty('email');
  });

  it.each([[null, 'an unknown token']])('refuses %s', async (record) => {
    const { service } = build(record, LIVE);
    await expect(service.resolveUserinfo('tok')).rejects.toThrow(
      /expired|revoked|invalid/i,
    );
  });

  it.each<[unknown, string]>([
    [{ ...LIVE, revoked_at: new Date() }, 'a revoked consent'],
    [
      { ...LIVE, app: { status: 'SUSPENDED', deleted_at: null } },
      'a suspended app',
    ],
    [
      { ...LIVE, app: { status: 'ACTIVE', deleted_at: new Date() } },
      'a deleted app',
    ],
    [null, 'a vanished authorization'],
  ])(
    'refuses when the grant is no longer live: %#  (%s)',
    async (authorization) => {
      const { service } = build(RECORD, authorization);
      await expect(service.resolveUserinfo('tok')).rejects.toThrow();
    },
  );

  /** Whatever invalidated it will not un-invalidate itself. */
  it('drops the token rather than re-checking it on every retry', async () => {
    const { service, store } = build(RECORD, {
      ...LIVE,
      revoked_at: new Date(),
    });
    await service.resolveUserinfo('tok').catch(() => undefined);
    expect(store.size).toBe(0);
  });

  it('survives a corrupt token record without throwing a parse error', async () => {
    const { service, store } = build(RECORD, LIVE);
    store.set('rabotka:dev:oauth:at:tok', 'not json');
    await expect(service.resolveUserinfo('tok')).rejects.toThrow(/invalid/i);
  });

  it('normalises the issuer, since clients compare it byte-for-byte', () => {
    const { service } = build(RECORD, LIVE);
    expect(service.issuer()).toBe('https://api.rabotka.work');
  });

  it('mints an opaque access token, not a second JWT', async () => {
    const { service } = build(RECORD, LIVE);
    const token = await service.mintAccessToken(RECORD);
    expect(token).toMatch(/^rbk_at_/);
    expect(token.split('.')).toHaveLength(1);
  });
});
