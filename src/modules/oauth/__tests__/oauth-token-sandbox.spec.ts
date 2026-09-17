import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { Request } from 'express';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthTokenController } from '../oauth-token.controller';
import { OAuthTokenService } from '../services/oauth-token.service';
import { OAuthSandboxService } from '../services/oauth-sandbox.service';
import type { OAuthAppService } from '../services/oauth-app.service';
import type { OAuthCodeService } from '../services/oauth-code.service';
import type { OidcKeyService } from '../services/oidc-key.service';
import { derivePairwiseSub } from '../utils/client-credentials.util';
import { OAuthError } from '../oauth-error';

const SALT = 'salt';
const SANDBOX_SUBJECT = 'sandbox:verified';
const REDIRECT = 'https://partner.com/cb';
const VERIFIER = 'v'.repeat(43);

const config = {
  get: (key: string) =>
    ({
      OIDC_PAIRWISE_SALT: SALT,
      OIDC_ISSUER: 'https://api.rabotka.work',
    })[key],
} as unknown as ConfigService;

const APP = {
  id: 'app-1',
  client_id: 'rbk_abc',
  status: 'ACTIVE',
  is_sandbox: true,
  deleted_at: null,
};

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
 * A grant as `OAuthCodeService.consume` returns it. The code challenge is the
 * real SHA-256 of VERIFIER so `verifyCodeChallenge` passes without being
 * stubbed — the PKCE check is not what these tests are about, but it must not
 * be the thing that fails them either.
 */
function grantFor(profileId: string) {
  return {
    appId: APP.id,
    clientId: APP.client_id,
    profileId,
    redirectUri: REDIRECT,
    scopes: ['openid', 'profile', 'phone', 'rabotka:verification'],
    codeChallenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    nonce: 'n-1',
    authTime: 1_700_000_000,
  };
}

function build(overrides: { app?: unknown; profileId?: string } = {}) {
  const app = 'app' in overrides ? overrides.app : APP;
  const profileId = overrides.profileId ?? SANDBOX_SUBJECT;

  const apps = {
    authenticateClient: jest.fn().mockResolvedValue(app),
  } as unknown as jest.Mocked<OAuthAppService>;

  const codes = {
    consume: jest.fn().mockResolvedValue(grantFor(profileId)),
  } as unknown as jest.Mocked<OAuthCodeService>;

  const prisma = {
    oAuthAuthorization: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'auth-1',
        pairwise_sub: 'real-sub',
        revoked_at: null,
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    oAuthApp: { findFirst: jest.fn().mockResolvedValue(app) },
    profile: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p-1',
        first_name: 'Amina',
        last_name: 'N',
        phone: '+237690000042',
        email: 'a@b.com',
        avatar_url: null,
        city: 'Douala',
        country_code: 'CM',
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        verified_at: new Date('2026-02-02T00:00:00.000Z'),
      }),
    },
  } as unknown as PrismaService;

  const sandbox = new OAuthSandboxService(config);

  const keys = {
    signingKey: () => ({ key: 'k' as never, kid: 'kid-1' }),
  } as unknown as OidcKeyService;

  const tokens = new OAuthTokenService(
    {} as unknown as Redis,
    prisma,
    config,
    keys,
    sandbox,
  );

  // Signing needs a real key; these tests are about what happens around it.
  jest.spyOn(tokens, 'signIdToken').mockResolvedValue('the-id-token');
  jest.spyOn(tokens, 'mintAccessToken').mockResolvedValue('rbk_at_x');

  const controller = new OAuthTokenController(
    apps,
    codes,
    tokens,
    prisma,
    sandbox,
  );

  return { controller, prisma, tokens, apps, codes, sandbox };
}

const body = {
  grant_type: 'authorization_code',
  code: 'the-code',
  redirect_uri: REDIRECT,
  code_verifier: VERIFIER,
};

const req = { headers: {} } as unknown as Request;

describe('token exchange for a sandbox subject', () => {
  it('issues tokens without reading or stamping an authorization row', async () => {
    const { controller, prisma } = build();

    const result = await controller.token(body, req);

    expect(result.id_token).toBe('the-id-token');
    expect(result.access_token).toBe('rbk_at_x');
    expect(prisma.oAuthAuthorization.findUnique).not.toHaveBeenCalled();
    expect(prisma.oAuthAuthorization.update).not.toHaveBeenCalled();
    expect(prisma.profile.findFirst).not.toHaveBeenCalled();
  });

  it('signs the pairwise sub the consent step derived', async () => {
    const { controller, tokens } = build();

    await controller.token(body, req);

    expect(tokens.signIdToken).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          sub: derivePairwiseSub(APP.id, SANDBOX_SUBJECT, SALT),
          name: 'Rabotka Sandbox',
          phone_number: '+242061111111',
          phone_number_verified: true,
          rabotka_verified: true,
        }),
      }),
    );
  });

  /**
   * Invariant B at the token endpoint: a code carrying a synthetic subject must
   * not be redeemable by a real application, whatever else is true.
   */
  it('refuses a sandbox subject presented by a real app', async () => {
    const { controller } = build({ app: { ...APP, is_sandbox: false } });

    const error = await expectOAuthError(controller.token(body, req));
    expect(error.code).toBe('invalid_grant');
  });

  /**
   * The mirror, and the case that made this check worth having at all: an admin
   * flipping `is_sandbox` in the sixty seconds a code lives. Without it the
   * real subject would be looked up with a uuid-shaped id under a sandbox app,
   * or the synthetic one under a real app, and the partner would see a 500.
   */
  it('refuses a real subject presented by a sandbox app', async () => {
    const { controller } = build({ profileId: 'p-1' });

    const error = await expectOAuthError(controller.token(body, req));
    expect(error.code).toBe('invalid_grant');
  });

  it('refuses an unknown sandbox subject', async () => {
    const { controller } = build({ profileId: 'sandbox:nobody' });

    const error = await expectOAuthError(controller.token(body, req));
    expect(error.code).toBe('invalid_grant');
  });

  it('still reads the authorization row for a real exchange', async () => {
    const { controller, prisma } = build({
      app: { ...APP, is_sandbox: false },
      profileId: 'p-1',
    });

    await controller.token(body, req);

    expect(prisma.oAuthAuthorization.findUnique).toHaveBeenCalled();
    expect(prisma.oAuthAuthorization.update).toHaveBeenCalled();
    expect(prisma.profile.findFirst).toHaveBeenCalled();
  });
});

describe('userinfo for a sandbox token', () => {
  function withToken(record: Record<string, unknown>, app: unknown) {
    const store = new Map<string, string>([
      ['rabotka:dev:oauth:at:tok', JSON.stringify(record)],
    ]);

    const redis = {
      get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      del: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve(1);
      }),
    } as unknown as Redis;

    const prisma = {
      oAuthApp: { findFirst: jest.fn().mockResolvedValue(app) },
      oAuthAuthorization: { findUnique: jest.fn() },
    } as unknown as PrismaService;

    const service = new OAuthTokenService(
      redis,
      prisma,
      config,
      {} as unknown as OidcKeyService,
      new OAuthSandboxService(config),
    );

    return { service, redis, prisma, store };
  }

  const RECORD = {
    authorizationId: 'sandbox:authorization',
    profileId: SANDBOX_SUBJECT,
    clientId: APP.client_id,
    scopes: ['openid', 'profile', 'rabotka:verification'],
  };

  it('resolves claims without touching the authorization table', async () => {
    const { service, prisma } = withToken(RECORD, APP);

    await expect(service.resolveUserinfo('tok')).resolves.toMatchObject({
      sub: derivePairwiseSub(APP.id, SANDBOX_SUBJECT, SALT),
      name: 'Rabotka Sandbox',
      rabotka_verified: true,
    });
    expect(prisma.oAuthAuthorization.findUnique).not.toHaveBeenCalled();
  });

  it('honours scope, so an ungranted claim is still absent', async () => {
    const { service } = withToken({ ...RECORD, scopes: ['openid'] }, APP);

    await expect(service.resolveUserinfo('tok')).resolves.toEqual({
      sub: derivePairwiseSub(APP.id, SANDBOX_SUBJECT, SALT),
    });
  });

  /**
   * A suspension has to bite on the next request rather than at expiry, and it
   * has to bite for sandbox tokens too — the app-level kill switch is the only
   * revocation a sandbox grant has, since there is no row to revoke.
   */
  const revoking: [unknown, string][] = [
    [{ ...APP, status: 'SUSPENDED' }, 'a suspended app'],
    [null, 'a deleted app'],
    [{ ...APP, is_sandbox: false }, 'an app that is no longer a sandbox'],
  ];

  it.each(revoking)('refuses and drops the token for %s', async (app) => {
    const { service, store } = withToken(RECORD, app);

    const error = await expectOAuthError(service.resolveUserinfo('tok'));

    expect(error.code).toBe('invalid_token');
    // Dropped from Redis: whatever invalidated it will not un-invalidate
    // itself, so keeping it only costs a round trip on every retry.
    expect(store.size).toBe(0);
  });
});
