import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthAuthorizationService } from '../services/oauth-authorization.service';
import type { OAuthAppService } from '../services/oauth-app.service';
import type { OAuthCodeService } from '../services/oauth-code.service';
import type { OAuthInteractionService } from '../services/oauth-interaction.service';
import { OAuthError } from '../oauth-error';

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

const CHALLENGE = 'a'.repeat(43);
const REDIRECT = 'https://partner.com/cb';

const APP = {
  id: 'app-1',
  client_id: 'rbk_abc',
  status: 'ACTIVE',
  redirect_uris: [REDIRECT],
  allowed_scopes: ['openid', 'profile', 'phone', 'rabotka:verification'],
  deleted_at: null,
};

function build(
  overrides: {
    app?: unknown;
    profile?: unknown;
    authorization?: unknown;
  } = {},
) {
  const interactions = {
    create: jest.fn().mockResolvedValue('int-1'),
    require: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<OAuthInteractionService>;

  const codes = {
    mint: jest.fn().mockResolvedValue('the-code'),
  } as unknown as jest.Mocked<OAuthCodeService>;

  const app = 'app' in overrides ? overrides.app : APP;

  const apps = {
    findByClientId: jest.fn().mockResolvedValue(app),
    grantableScopes: (a: { allowed_scopes: string[] }, requested: string[]) =>
      requested.filter((s) => a.allowed_scopes.includes(s)),
  } as unknown as jest.Mocked<OAuthAppService>;

  const prisma = {
    oAuthApp: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        name: 'Chantier',
        description: 'desc',
        logo_url: null,
      }),
      findFirst: jest.fn().mockResolvedValue(app),
    },
    profile: {
      // `in` rather than `??`: a test passing `profile: null` means "this
      // profile is gone", which `??` would quietly replace with the default.
      findFirst: jest.fn().mockResolvedValue(
        'profile' in overrides
          ? overrides.profile
          : {
              id: 'p-1',
              status: 'ACTIVE',
              first_name: 'Amina',
              last_name: 'N',
              phone: '+237690000042',
              avatar_url: null,
            },
      ),
    },
    oAuthAuthorization: {
      findUnique: jest.fn().mockResolvedValue(overrides.authorization ?? null),
      upsert: jest.fn().mockResolvedValue({ id: 'auth-1' }),
    },
  } as unknown as PrismaService;

  const config = {
    get: (key: string) => (key === 'OIDC_PAIRWISE_SALT' ? 'salt' : undefined),
  } as unknown as ConfigService;

  const service = new OAuthAuthorizationService(
    prisma,
    config,
    apps,
    interactions,
    codes,
  );

  return { service, prisma, apps, interactions, codes };
}

const validQuery = {
  client_id: 'rbk_abc',
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: 'openid profile',
  state: 'st-1',
  nonce: 'n-1',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
};

describe('beginAuthorization', () => {
  it('opens an interaction for a well-formed request', async () => {
    const { service, interactions } = build();
    await expect(service.beginAuthorization(validQuery, null)).resolves.toEqual(
      {
        interactionId: 'int-1',
      },
    );

    expect(interactions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        redirectUri: REDIRECT,
        scopes: ['openid', 'profile'],
        state: 'st-1',
        nonce: 'n-1',
        codeChallenge: CHALLENGE,
        profileId: null,
      }),
    );
  });

  it('stamps authTime when an existing session is reused', async () => {
    const { service, interactions } = build();
    await service.beginAuthorization(validQuery, 'p-1');

    const arg = (interactions.create as jest.Mock).mock.calls[0][0];
    expect(arg.profileId).toBe('p-1');
    expect(typeof arg.authTime).toBe('number');
  });

  it('leaves authTime unset when there is no session to reuse', async () => {
    const { service, interactions } = build();
    await service.beginAuthorization(validQuery, null);
    expect(
      (interactions.create as jest.Mock).mock.calls[0][0].authTime,
    ).toBeUndefined();
  });

  /**
   * Phase 1 — nothing may redirect anywhere. These are the failures that would
   * turn the endpoint into an open redirector, so they must be rendered on
   * Rabotka's own page instead.
   */
  describe('refuses without redirecting', () => {
    const expectNoRedirect = async (promise: Promise<unknown>) => {
      const error = await expectOAuthError(promise);
      expect(error.redirectUri).toBeUndefined();
      return error;
    };

    it('a missing client_id', async () => {
      const { service } = build();
      const error = await expectNoRedirect(
        service.beginAuthorization(
          { ...validQuery, client_id: undefined },
          null,
        ),
      );
      expect(error.code).toBe('invalid_request');
    });

    it('an unknown client_id', async () => {
      const { service } = build({ app: null });
      const error = await expectNoRedirect(
        service.beginAuthorization(validQuery, null),
      );
      expect(error.code).toBe('unauthorized_client');
    });

    it('a suspended application', async () => {
      const { service } = build({ app: { ...APP, status: 'SUSPENDED' } });
      const error = await expectNoRedirect(
        service.beginAuthorization(validQuery, null),
      );
      expect(error.code).toBe('unauthorized_client');
    });

    it('gives suspended and unknown the same message', async () => {
      const unknown = await expectOAuthError(
        build({ app: null }).service.beginAuthorization(validQuery, null),
      );
      const suspended = await expectOAuthError(
        build({
          app: { ...APP, status: 'SUSPENDED' },
        }).service.beginAuthorization(validQuery, null),
      );

      expect(unknown.description).toBe(suspended.description);
    });

    it('a missing redirect_uri', async () => {
      const { service } = build();
      await expectNoRedirect(
        service.beginAuthorization(
          { ...validQuery, redirect_uri: undefined },
          null,
        ),
      );
    });

    it.each([
      [`${REDIRECT}/`, 'a trailing slash'],
      [`${REDIRECT}.evil.com`, 'a suffixed host'],
      ['https://evil.com/cb', 'a different host'],
      [REDIRECT.replace('https', 'http'), 'a downgraded scheme'],
    ])('an unregistered redirect_uri: %s (%s)', async (uri) => {
      const { service } = build();
      const error = await expectNoRedirect(
        service.beginAuthorization({ ...validQuery, redirect_uri: uri }, null),
      );
      expect(error.code).toBe('invalid_request');
    });
  });

  /**
   * Phase 2 — the redirect URI is proven, so the partner's developer gets told
   * where they will actually see it.
   */
  describe('reports back to the partner', () => {
    const expectRedirect = async (query: Record<string, unknown>) => {
      const { service } = build();
      const error = await expectOAuthError(
        service.beginAuthorization(query, null),
      );
      expect(error).toBeInstanceOf(OAuthError);
      expect(error.redirectUri).toBe(REDIRECT);
      expect(error.state).toBe('st-1');
      return error;
    };

    it('an unsupported response_type', async () => {
      const error = await expectRedirect({
        ...validQuery,
        response_type: 'token',
      });
      expect(error.code).toBe('unsupported_response_type');
    });

    it.each<[string | undefined, string]>([
      ['plain', 'the removed plain method'],
      [undefined, 'no method at all'],
    ])('code_challenge_method=%s (%s)', async (method) => {
      const error = await expectRedirect({
        ...validQuery,
        code_challenge_method: method,
      });
      expect(error.code).toBe('invalid_request');
    });

    it.each<[string | undefined, string]>([
      ['too-short', 'a short challenge'],
      ['x'.repeat(64), 'hex rather than base64url'],
      [undefined, 'no challenge'],
    ])('a malformed code_challenge: %s (%s)', async (challenge) => {
      const error = await expectRedirect({
        ...validQuery,
        code_challenge: challenge,
      });
      expect(error.code).toBe('invalid_request');
    });

    it.each<[string | undefined, string]>([
      ['profile', 'openid missing'],
      [undefined, 'no scope at all'],
    ])('scope=%s (%s)', async (scope) => {
      const error = await expectRedirect({ ...validQuery, scope });
      expect(error.code).toBe('invalid_scope');
    });

    it('an unknown scope', async () => {
      const error = await expectRedirect({
        ...validQuery,
        scope: 'openid rabotka:not_a_scope',
      });
      expect(error.code).toBe('invalid_scope');
    });

    /** Refused, not silently dropped — a partner must find out at integration. */
    it('a scope the app was never granted', async () => {
      const error = await expectRedirect({
        ...validQuery,
        scope: 'openid email',
      });
      expect(error.code).toBe('invalid_scope');
      expect(error.description).toContain('email');
    });
  });
});

describe('hasStandingGrant', () => {
  it('is false with no prior authorization', async () => {
    const { service } = build();
    await expect(
      service.hasStandingGrant('app-1', 'p-1', ['openid']),
    ).resolves.toBe(false);
  });

  it('is false once revoked', async () => {
    const { service } = build({
      authorization: { scopes: ['openid'], revoked_at: new Date() },
    });
    await expect(
      service.hasStandingGrant('app-1', 'p-1', ['openid']),
    ).resolves.toBe(false);
  });

  it('is true when the prior grant covers everything asked for', async () => {
    const { service } = build({
      authorization: { scopes: ['openid', 'profile'], revoked_at: null },
    });
    await expect(
      service.hasStandingGrant('app-1', 'p-1', ['openid', 'profile']),
    ).resolves.toBe(true);
  });

  /** An app that starts asking for more must re-prompt. */
  it('is false when the app now asks for more than was granted', async () => {
    const { service } = build({
      authorization: { scopes: ['openid'], revoked_at: null },
    });
    await expect(
      service.hasStandingGrant('app-1', 'p-1', ['openid', 'phone']),
    ).resolves.toBe(false);
  });
});

describe('consentContext', () => {
  it('describes the app and the signed-in person', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue({
      appId: 'app-1',
      scopes: ['openid', 'profile'],
      profileId: 'p-1',
    });

    const ctx = await service.consentContext('int-1');
    expect(ctx.app.name).toBe('Chantier');
    expect(ctx.profile).toEqual({
      firstName: 'Amina',
      lastName: 'N',
      phoneHint: '••42',
      avatarUrl: null,
    });
  });

  it('has no profile before the visitor has authenticated', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue({
      appId: 'app-1',
      scopes: ['openid'],
      profileId: null,
    });

    const ctx = await service.consentContext('int-1');
    expect(ctx.profile).toBeNull();
    expect(ctx.alreadyGranted).toBe(false);
  });

  it('survives a profile that has since been deleted', async () => {
    const { service, interactions } = build({ profile: null });
    (interactions.require as jest.Mock).mockResolvedValue({
      appId: 'app-1',
      scopes: ['openid'],
      profileId: 'p-1',
    });

    await expect(service.consentContext('int-1')).resolves.toMatchObject({
      profile: null,
    });
  });
});

describe('approve', () => {
  const interaction = {
    appId: 'app-1',
    redirectUri: REDIRECT,
    scopes: ['openid', 'profile'],
    state: 'st-1',
    nonce: 'n-1',
    codeChallenge: CHALLENGE,
    profileId: 'p-1',
    authTime: 1_700_000_000,
  };

  it('mints a code and returns to the partner with state', async () => {
    const { service, interactions, codes } = build();
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    const { redirectTo } = await service.approve('int-1');
    const url = new URL(redirectTo);

    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('the-code');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(codes.mint).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'n-1', authTime: 1_700_000_000 }),
    );
  });

  it('destroys the interaction so a second POST cannot mint another code', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    await service.approve('int-1');
    expect(interactions.destroy).toHaveBeenCalledWith('int-1');
  });

  it('refuses before the visitor has authenticated', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue({
      ...interaction,
      profileId: null,
    });

    const error = await expectOAuthError(service.approve('int-1'));
    expect(error.code).toBe('login_required');
  });

  it('refuses a banned account, redirecting so the partner learns of it', async () => {
    const { service, interactions } = build({
      profile: { id: 'p-1', status: 'BANNED' },
    });
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    const error = await expectOAuthError(service.approve('int-1'));
    expect(error.code).toBe('access_denied');
    expect(error.redirectUri).toBe(REDIRECT);
  });

  it('refuses if the app was suspended between authorize and consent', async () => {
    const { service, interactions, prisma } = build();
    (interactions.require as jest.Mock).mockResolvedValue(interaction);
    (prisma.oAuthApp.findFirst as jest.Mock).mockResolvedValue({
      ...APP,
      status: 'SUSPENDED',
    });

    const error = await expectOAuthError(service.approve('int-1'));
    expect(error.code).toBe('unauthorized_client');
  });

  /** Union, so an app asking for less later does not silently lose access. */
  it('unions new scopes with the ones already granted', async () => {
    const { service, interactions, prisma } = build({
      authorization: { scopes: ['phone'], revoked_at: null },
    });
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    await service.approve('int-1');
    const upsert = (prisma.oAuthAuthorization.upsert as jest.Mock).mock
      .calls[0][0];
    expect([...upsert.update.scopes.set].sort()).toEqual(
      ['openid', 'phone', 'profile'].sort(),
    );
  });

  it('starts fresh after a revocation rather than resurrecting old scopes', async () => {
    const { service, interactions, prisma } = build({
      authorization: { scopes: ['email'], revoked_at: new Date() },
    });
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    await service.approve('int-1');
    const upsert = (prisma.oAuthAuthorization.upsert as jest.Mock).mock
      .calls[0][0];
    expect(upsert.update.scopes.set).not.toContain('email');
    expect(upsert.update.revoked_at).toBeNull();
  });

  it('fails loudly when the pairwise salt is unset', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue(interaction);

    (service as any).config = { get: () => undefined };

    await expect(service.approve('int-1')).rejects.toThrow(
      /OIDC_PAIRWISE_SALT/,
    );
  });
});

describe('deny', () => {
  it('returns access_denied to the partner with state', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue({
      redirectUri: REDIRECT,
      state: 'st-1',
    });

    const { redirectTo } = await service.deny('int-1');
    const url = new URL(redirectTo);

    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.has('code')).toBe(false);
    expect(interactions.destroy).toHaveBeenCalledWith('int-1');
  });

  it('preserves a query string the partner already had on its callback', async () => {
    const { service, interactions } = build();
    (interactions.require as jest.Mock).mockResolvedValue({
      redirectUri: `${REDIRECT}?tenant=42`,
      state: undefined,
    });

    const url = new URL((await service.deny('int-1')).redirectTo);
    expect(url.searchParams.get('tenant')).toBe('42');
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.has('state')).toBe(false);
  });
});
