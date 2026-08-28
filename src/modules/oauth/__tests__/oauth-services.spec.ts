import type Redis from 'ioredis';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthAppService } from '../services/oauth-app.service';
import { OAuthCodeService } from '../services/oauth-code.service';
import { OAuthInteractionService } from '../services/oauth-interaction.service';
import { OAuthError } from '../oauth-error';
import { hashClientSecret } from '../utils/client-credentials.util';
import { MAX_OTP_ATTEMPTS } from '../oauth.constants';

/**
 * Asserts the promise rejects with an OAuthError and narrows the type.
 *
 * `` reads fine but types the result as a union of
 * the error and the resolved value, so every property access after it is a
 * compile error.
 */
async function expectOAuthError(
  promise: Promise<unknown>,
): Promise<OAuthError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OAuthError);
  return caught as OAuthError;
}

/**
 * A Redis stand-in with just the four calls these services make.
 *
 * `eval` implements the GET+DEL script's contract rather than the script: what
 * matters to the caller is that a second read of the same key returns nothing,
 * which is the single-use guarantee the whole code flow rests on.
 */
function fakeRedis() {
  const store = new Map<string, string>();
  // Not `async`: nothing here awaits, and the callers only need a thenable.
  return {
    store,
    set(key: string, value: string) {
      store.set(key, value);
      return Promise.resolve('OK');
    },
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    },
    del(key: string) {
      return Promise.resolve(store.delete(key) ? 1 : 0);
    },
    eval(_script: string, _n: number, key: string) {
      const value = store.get(key);
      if (value === undefined) return Promise.resolve(null);
      store.delete(key);
      return Promise.resolve(value);
    },
  } as unknown as Redis & { store: Map<string, string> };
}

// ---------------------------------------------------------------------------

describe('OAuthAppService', () => {
  const app = (overrides: Record<string, unknown> = {}) => ({
    id: 'app-1',
    client_id: 'rbk_abc',
    client_secret_hash: hashClientSecret('rbk_sk_right'),
    previous_secret_hash: null,
    previous_secret_expires_at: null,
    status: 'ACTIVE',
    allowed_scopes: ['openid', 'profile', 'phone'],
    ...overrides,
  });

  function service(found: unknown) {
    const prisma = {
      oAuthApp: { findFirst: jest.fn().mockResolvedValue(found) },
    } as unknown as PrismaService;
    return new OAuthAppService(prisma);
  }

  describe('authenticateClient', () => {
    it('accepts the current secret', async () => {
      await expect(
        service(app()).authenticateClient('rbk_abc', 'rbk_sk_right'),
      ).resolves.toMatchObject({ id: 'app-1' });
    });

    it('refuses the wrong secret', async () => {
      await expect(
        service(app()).authenticateClient('rbk_abc', 'rbk_sk_wrong'),
      ).rejects.toThrow(OAuthError);
    });

    /**
     * Unknown client and wrong secret must be indistinguishable, or the
     * endpoint becomes a directory of which client_ids exist.
     */
    it('gives an unknown client the same error as a wrong secret', async () => {
      const unknown = await expectOAuthError(
        service(null).authenticateClient('nope', 'x'),
      );
      const wrong = await expectOAuthError(
        service(app()).authenticateClient('rbk_abc', 'wrong'),
      );

      expect(unknown.code).toBe(wrong.code);
      expect(unknown.description).toBe(wrong.description);
      expect(unknown.status).toBe(401);
    });

    it('refuses a suspended app even with the right secret', async () => {
      await expect(
        service(app({ status: 'SUSPENDED' })).authenticateClient(
          'rbk_abc',
          'rbk_sk_right',
        ),
      ).rejects.toThrow(OAuthError);
    });

    it('refuses an empty secret', async () => {
      await expect(
        service(app()).authenticateClient('rbk_abc', ''),
      ).rejects.toThrow(OAuthError);
    });

    it('accepts the previous secret inside the rotation grace window', async () => {
      const withPrevious = app({
        client_secret_hash: hashClientSecret('rbk_sk_new'),
        previous_secret_hash: hashClientSecret('rbk_sk_old'),
        previous_secret_expires_at: new Date(Date.now() + 60_000),
      });
      await expect(
        service(withPrevious).authenticateClient('rbk_abc', 'rbk_sk_old'),
      ).resolves.toMatchObject({ id: 'app-1' });
    });

    it('refuses the previous secret once the window has closed', async () => {
      const expired = app({
        client_secret_hash: hashClientSecret('rbk_sk_new'),
        previous_secret_hash: hashClientSecret('rbk_sk_old'),
        previous_secret_expires_at: new Date(Date.now() - 1),
      });
      await expect(
        service(expired).authenticateClient('rbk_abc', 'rbk_sk_old'),
      ).rejects.toThrow(OAuthError);
    });
  });

  describe('findByClientId', () => {
    it.each<[string | undefined, string]>([
      ['', 'empty'],
      [undefined, 'undefined'],
    ])(
      'returns null for a %s client_id without hitting the database',
      async (value) => {
        const prisma = {
          oAuthApp: { findFirst: jest.fn() },
        } as unknown as PrismaService;
        const svc = new OAuthAppService(prisma);

        await expect(svc.findByClientId(value as string)).resolves.toBeNull();
        expect(prisma.oAuthApp.findFirst).not.toHaveBeenCalled();
      },
    );
  });

  describe('grantableScopes', () => {
    it('intersects with what the app was granted', () => {
      const svc = service(null);
      expect(
        svc.grantableScopes(app() as never, ['openid', 'phone', 'email']),
      ).toEqual(['openid', 'phone']);
    });

    it('returns nothing when none overlap', () => {
      expect(
        service(null).grantableScopes(app({ allowed_scopes: [] }) as never, [
          'openid',
        ]),
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------

describe('OAuthCodeService', () => {
  const grant = {
    appId: 'app-1',
    clientId: 'rbk_abc',
    profileId: 'p-1',
    redirectUri: 'https://p.com/cb',
    scopes: ['openid'],
    codeChallenge: 'c'.repeat(43),
    authTime: 1,
  };

  it('mints an opaque code that resolves back to its grant', async () => {
    const svc = new OAuthCodeService(fakeRedis());
    const code = await svc.mint(grant);

    expect(code).not.toContain('app-1');
    await expect(svc.consume(code)).resolves.toEqual(grant);
  });

  /** The property the whole flow rests on: a code is spendable once. */
  it('refuses the second redemption of the same code', async () => {
    const svc = new OAuthCodeService(fakeRedis());
    const code = await svc.mint(grant);

    await expect(svc.consume(code)).resolves.toEqual(grant);
    await expect(svc.consume(code)).resolves.toBeNull();
  });

  it('only one of two concurrent redemptions wins', async () => {
    const svc = new OAuthCodeService(fakeRedis());
    const code = await svc.mint(grant);

    const [a, b] = await Promise.all([svc.consume(code), svc.consume(code)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it.each([
    ['', 'empty'],
    ['unknown-code', 'unknown'],
  ])('returns null for an %s code', async (code) => {
    await expect(
      new OAuthCodeService(fakeRedis()).consume(code),
    ).resolves.toBeNull();
  });

  it('returns null rather than throwing on a corrupt record', async () => {
    const redis = fakeRedis();
    const svc = new OAuthCodeService(redis);
    const code = await svc.mint(grant);
    // Simulate a value that is not JSON.
    for (const key of redis.store.keys()) redis.store.set(key, 'not json');

    await expect(svc.consume(code)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('OAuthInteractionService', () => {
  const base = {
    appId: 'app-1',
    clientId: 'rbk_abc',
    redirectUri: 'https://p.com/cb',
    scopes: ['openid'],
    codeChallenge: 'c'.repeat(43),
    profileId: null,
  };

  it('round-trips an interaction', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const id = await svc.create(base);
    await expect(svc.get(id)).resolves.toMatchObject({
      ...base,
      otpAttempts: 0,
    });
  });

  it.each([
    ['', 'empty'],
    ['nope', 'unknown'],
  ])('get() returns null for an %s id', async (id) => {
    await expect(
      new OAuthInteractionService(fakeRedis()).get(id),
    ).resolves.toBeNull();
  });

  it('require() raises interaction_required rather than a bare 404', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const error = await expectOAuthError(svc.require('gone'));
    expect(error.code).toBe('interaction_required');
  });

  it('patch() merges without dropping the untouched fields', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const id = await svc.create(base);

    const patched = await svc.patch(id, { profileId: 'p-1' });
    expect(patched.profileId).toBe('p-1');
    expect(patched.clientId).toBe('rbk_abc');
    expect(patched.codeChallenge).toBe(base.codeChallenge);
  });

  it('counts down OTP attempts and reports what is left', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const id = await svc.create(base);

    const first = await svc.recordFailedOtp(id);
    expect(first.attemptsLeft).toBe(MAX_OTP_ATTEMPTS - 1);
  });

  /**
   * Burning the interaction — rather than locking the phone number — is what
   * stops the attempt counter from being a denial-of-service handle against
   * somebody else's account.
   */
  it('burns the interaction on the last attempt', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const id = await svc.create(base);

    for (let i = 0; i < MAX_OTP_ATTEMPTS - 1; i++) {
      await svc.recordFailedOtp(id);
    }

    const error = await expectOAuthError(svc.recordFailedOtp(id));
    expect(error.code).toBe('access_denied');
    await expect(svc.get(id)).resolves.toBeNull();
  });

  it('destroy() removes it', async () => {
    const svc = new OAuthInteractionService(fakeRedis());
    const id = await svc.create(base);
    await svc.destroy(id);
    await expect(svc.get(id)).resolves.toBeNull();
  });

  it('survives a corrupt record without throwing', async () => {
    const redis = fakeRedis();
    const svc = new OAuthInteractionService(redis);
    const id = await svc.create(base);
    for (const key of redis.store.keys()) redis.store.set(key, '{oops');

    await expect(svc.get(id)).resolves.toBeNull();
  });
});

describe('OAuthAppService registration', () => {
  function writable() {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const prisma = {
      oAuthApp: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({ ...data, id: 'app-1' });
        }),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return Promise.resolve({ id: 'app-1', ...data });
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'app-1',
          client_id: 'rbk_abc',
          client_secret_hash: hashClientSecret('rbk_sk_old'),
        }),
      },
    } as unknown as PrismaService;
    return { service: new OAuthAppService(prisma), prisma, created, updated };
  }

  const base = {
    name: 'Chantier',
    description: 'A partner application.',
    contactEmail: 'Dev@Partner.COM',
    redirectUris: ['https://partner.com/cb'],
  };

  it('mints a client id and a secret, storing only the hash', async () => {
    const { service, created } = writable();
    const { secret } = await service.create(base);

    expect(secret.clientId).toMatch(/^rbk_/);
    expect(secret.clientSecret).toMatch(/^rbk_sk_/);
    expect(created[0].client_secret_hash).toBe(
      hashClientSecret(secret.clientSecret),
    );
    // The plaintext must never be written anywhere.
    expect(JSON.stringify(created[0])).not.toContain(secret.clientSecret);
  });

  it('keeps only the last four characters as a hint', async () => {
    const { service, created } = writable();
    const { secret } = await service.create(base);
    expect(created[0].client_secret_hint).toBe(secret.clientSecret.slice(-4));
  });

  it('lowercases the contact email and trims the text fields', async () => {
    const { service, created } = writable();
    await service.create({ ...base, name: '  Chantier  ' });
    expect(created[0].contact_email).toBe('dev@partner.com');
    expect(created[0].name).toBe('Chantier');
  });

  it('defaults to the scopes that answer "is this a verified person"', async () => {
    const { service, created } = writable();
    await service.create(base);
    expect(created[0].allowed_scopes).toEqual([
      'openid',
      'profile',
      'phone',
      'rabotka:verification',
    ]);
    // Personal data a partner has to ask for stays out by default.
    expect(created[0].allowed_scopes).not.toContain('email');
  });

  it('adds openid when an admin leaves it out of the checkbox list', async () => {
    const { service, created } = writable();
    await service.create({ ...base, allowedScopes: ['profile'] });
    expect(created[0].allowed_scopes).toContain('openid');
  });

  it('refuses an unknown scope rather than dropping it', async () => {
    const { service } = writable();
    await expect(
      service.create({ ...base, allowedScopes: ['openid', 'not_a_scope'] }),
    ).rejects.toThrow(OAuthError);
  });

  it('deduplicates redirect URIs without reordering or rewriting them', async () => {
    const { service, created } = writable();
    await service.create({
      ...base,
      redirectUris: [
        'https://b.com/cb',
        'https://a.com/cb',
        'https://b.com/cb',
      ],
    });
    expect(created[0].redirect_uris).toEqual([
      'https://b.com/cb',
      'https://a.com/cb',
    ]);
  });

  it.each([
    [[], 'an empty list'],
    [['not-a-url'], 'a relative value'],
    [['https://*.partner.com/cb'], 'a wildcard'],
    [['http://partner.com/cb'], 'plain http on a public host'],
    [['https://partner.com/cb#frag'], 'a fragment'],
  ])('refuses %s (%s)', async (uris) => {
    const { service } = writable();
    await expect(
      service.create({ ...base, redirectUris: uris }),
    ).rejects.toThrow(OAuthError);
  });

  it('allows http on loopback, which native and local development need', async () => {
    const { service } = writable();
    await expect(
      service.create({ ...base, redirectUris: ['http://localhost:8787/cb'] }),
    ).resolves.toBeDefined();
  });

  describe('update', () => {
    it('touches only the fields it was given', async () => {
      const { service, updated } = writable();
      await service.update('app-1', { name: 'New' });
      expect(updated[0]).toEqual({ name: 'New' });
    });

    it('clears the logo when passed an empty string', async () => {
      const { service, updated } = writable();
      await service.update('app-1', { logoUrl: '' });
      expect(updated[0].logo_url).toBeNull();
    });

    it('validates redirect URIs on update too', async () => {
      const { service } = writable();
      await expect(
        service.update('app-1', { redirectUris: ['https://*.x.com/cb'] }),
      ).rejects.toThrow(OAuthError);
    });

    it('passes the status through', async () => {
      const { service, updated } = writable();
      await service.update('app-1', { status: 'SUSPENDED' });
      expect(updated[0].status).toBe('SUSPENDED');
    });
  });

  describe('rotateSecret', () => {
    it('issues a new secret and puts the old one on a countdown', async () => {
      const { service, updated } = writable();
      const secret = await service.rotateSecret('app-1');

      expect(secret.clientSecret).toMatch(/^rbk_sk_/);
      expect(updated[0].client_secret_hash).toBe(
        hashClientSecret(secret.clientSecret),
      );
      expect(updated[0].previous_secret_hash).toBe(
        hashClientSecret('rbk_sk_old'),
      );
      expect(
        (updated[0].previous_secret_expires_at as Date).getTime(),
      ).toBeGreaterThan(Date.now());
    });
  });

  describe('revokePreviousSecret', () => {
    it('ends the grace window immediately', async () => {
      const { service, updated } = writable();
      await service.revokePreviousSecret('app-1');
      expect(updated[0]).toEqual({
        previous_secret_hash: null,
        previous_secret_expires_at: null,
      });
    });
  });
});
