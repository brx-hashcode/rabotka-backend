import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importJWK, type JWK } from 'jose';
import { OidcKeyService, OIDC_SIGNING_ALG } from '../services/oidc-key.service';
import { OAuthTokenService } from '../services/oauth-token.service';

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
