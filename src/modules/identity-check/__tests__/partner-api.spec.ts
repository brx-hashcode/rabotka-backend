import { HttpException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IdentityCheckStatus, OAuthAppStatus } from '@prisma/client';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import { OAuthError } from '../../oauth/oauth-error';
import { IDENTITY_CHECK_SCOPE } from '../../oauth/oauth.constants';
import { OAuthAppService } from '../../oauth/services/oauth-app.service';
import { OidcKeyService } from '../../oauth/services/oidc-key.service';
import { OAuthTokenService } from '../../oauth/services/oauth-token.service';
import { OAuthSandboxService } from '../../oauth/services/oauth-sandbox.service';
import { hashClientSecret } from '../../oauth/utils/client-credentials.util';
import { validateWebhookUrl } from '../../oauth/utils/webhook-url.util';
import {
  PartnerClientAuthGuard,
  type PartnerRequest,
} from '../guards/partner-client-auth.guard';
import { IdentityCheckWebhookService } from '../identity-check-webhook.service';
import { WEBHOOK_JWS_TYPE } from '../identity-check.constants';

const configWith = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

function basic(clientId: string, secret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
}

describe('PartnerClientAuthGuard', () => {
  const app = (allowed_scopes: string[]) => ({
    id: 'app-1',
    client_id: 'rbk_app1',
    client_secret_hash: hashClientSecret('rbk_sk_right'),
    previous_secret_hash: null,
    previous_secret_expires_at: null,
    status: OAuthAppStatus.ACTIVE,
    allowed_scopes,
  });

  function run(found: unknown, authorization?: string) {
    const prisma = {
      oAuthApp: { findFirst: jest.fn().mockResolvedValue(found) },
    } as unknown as PrismaService;
    const guard = new PartnerClientAuthGuard(new OAuthAppService(prisma));
    const req = { headers: { authorization } } as unknown as PartnerRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { result: guard.canActivate(context), req };
  }

  it('lets an app with the switch on through and attaches it', async () => {
    const { result, req } = run(
      app(['openid', IDENTITY_CHECK_SCOPE]),
      basic('rbk_app1', 'rbk_sk_right'),
    );
    await expect(result).resolves.toBe(true);
    expect(req.partnerApp.client_id).toBe('rbk_app1');
  });

  it('refuses an app with the switch off, with its own error code', async () => {
    const { result } = run(
      app(['openid', 'profile']),
      basic('rbk_app1', 'rbk_sk_right'),
    );
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect((error as HttpException).getResponse()).toEqual({
      error: 'identity_check_not_enabled',
      error_description: expect.any(String),
    });
  });

  it.each([
    ['a wrong secret', basic('rbk_app1', 'rbk_sk_wrong')],
    ['no credentials', undefined],
    ['a bearer token', 'Bearer rbk_at_x'],
  ])('refuses %s as invalid_client', async (_label, header) => {
    const { result } = run(app([IDENTITY_CHECK_SCOPE]), header);
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe('invalid_client');
  });

  it('checks authentication before revealing the switch state', async () => {
    const { result } = run(app(['openid']), basic('rbk_app1', 'rbk_sk_wrong'));
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
  });
});

describe('IdentityCheckWebhookService', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const baseCheck = {
    id: 'check-1',
    status: IdentityCheckStatus.COMPLETED,
    reference: 'ref-1',
    created_at: new Date('2026-09-16T10:00:00.000Z'),
    expires_at: new Date('2026-09-17T10:00:00.000Z'),
    decided_at: new Date('2026-09-16T10:05:00.000Z'),
    result: { score: 91, recommendation: 'accept' },
    webhook_delivered_at: null,
  };

  const baseApp = {
    client_id: 'rbk_app1',
    webhook_url: 'https://partner.example/hooks/rabotka',
    status: OAuthAppStatus.ACTIVE,
    deleted_at: null,
  };

  async function setup(check: Record<string, unknown> = {}) {
    const keys = new OidcKeyService(
      configWith({ OIDC_PRIVATE_KEY: privateKey, OIDC_KEY_ID: 'kid-1' }),
    );
    await keys.onModuleInit();
    const tokens = new OAuthTokenService(
      {} as never,
      {} as never,
      configWith({ OIDC_ISSUER: 'https://api.rabotka.work' }),
      keys,
      new OAuthSandboxService(configWith({ OIDC_PAIRWISE_SALT: 's' })),
    );
    const prisma = {
      identityCheck: {
        findUnique: jest.fn().mockResolvedValue({
          ...baseCheck,
          app: baseApp,
          ...check,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new IdentityCheckWebhookService(
      prisma as unknown as PrismaService,
      keys,
      tokens,
    );
    return { service, prisma, keys };
  }

  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('posts a JWS that verifies against the published JWKS', async () => {
    const { service, prisma, keys } = await setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await service.deliver('check-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseApp.webhook_url);
    expect(init.redirect).toBe('error');

    const { jws } = JSON.parse(init.body as string) as { jws: string };
    const { payload, protectedHeader } = await jwtVerify(
      jws,
      createLocalJWKSet(keys.jwks()),
      { issuer: 'https://api.rabotka.work', audience: 'rbk_app1' },
    );

    expect(protectedHeader.typ).toBe(WEBHOOK_JWS_TYPE);
    expect(payload.sub).toBe('check-1');
    expect(payload.event).toBe('identity_check.updated');
    expect(payload.check).toEqual(
      expect.objectContaining({
        id: 'check-1',
        status: 'completed',
        reference: 'ref-1',
        score: 91,
        recommendation: 'accept',
      }),
    );
    expect(prisma.identityCheck.update).toHaveBeenCalledWith({
      where: { id: 'check-1' },
      data: expect.objectContaining({
        webhook_delivered_at: expect.any(Date),
        webhook_last_error: null,
      }),
    });
  });

  it('is not verifiable as another partner', async () => {
    const { service, keys } = await setup();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await service.deliver('check-1');

    const { jws } = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as { jws: string };
    await expect(
      jwtVerify(jws, createLocalJWKSet(keys.jwks()), {
        audience: 'rbk_other',
      }),
    ).rejects.toThrow();
  });

  it('records the failure and throws so the queue retries', async () => {
    const { service, prisma } = await setup();
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    await expect(service.deliver('check-1')).rejects.toThrow(/HTTP 503/);
    expect(prisma.identityCheck.update).toHaveBeenCalledWith({
      where: { id: 'check-1' },
      data: {
        webhook_attempts: { increment: 1 },
        webhook_last_error: 'HTTP 503',
      },
    });
  });

  it.each([
    ['already delivered', { webhook_delivered_at: new Date() }],
    ['still pending', { status: IdentityCheckStatus.PENDING_CONSENT }],
    ['an app without a webhook', { app: { ...baseApp, webhook_url: null } }],
    [
      'a suspended app',
      { app: { ...baseApp, status: OAuthAppStatus.SUSPENDED } },
    ],
    ['a deleted app', { app: { ...baseApp, deleted_at: new Date() } }],
  ])('sends nothing for %s', async (_label, check) => {
    const { service } = await setup(check);
    await service.deliver('check-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Identity-check switch on OAuth apps', () => {
  function writable(current: Record<string, unknown> = {}) {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const prisma = {
      oAuthApp: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve(data);
        }),
        update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          updated.push(data);
          return Promise.resolve(data);
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          allowed_scopes: ['openid'],
          webhook_url: null,
          redirect_uris: ['https://banque.example/cb'],
          is_sandbox: false,
          ...current,
        }),
      },
    } as unknown as PrismaService;
    return { service: new OAuthAppService(prisma), created, updated };
  }

  const base = {
    name: 'Banque',
    description: 'Une banque de test',
    contactEmail: 'dev@banque.example',
    redirectUris: ['https://banque.example/cb'],
  };

  const expectRequestError = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthError);
    expect((error as OAuthError).code).toBe('invalid_request');
  };

  it('refuses to create an app with the switch on and no webhook', async () => {
    const { service, created } = writable();
    await expectRequestError(
      service.create({ ...base, allowedScopes: [IDENTITY_CHECK_SCOPE] }),
    );
    expect(created).toHaveLength(0);
  });

  it('creates it when a webhook is given', async () => {
    const { service, created } = writable();
    await service.create({
      ...base,
      allowedScopes: [IDENTITY_CHECK_SCOPE],
      webhookUrl: ' https://banque.example/hook ',
    });
    expect(created[0]).toEqual(
      expect.objectContaining({
        allowed_scopes: expect.arrayContaining([
          'openid',
          IDENTITY_CHECK_SCOPE,
        ]),
        webhook_url: 'https://banque.example/hook',
      }),
    );
  });

  it('refuses to turn the switch on for an app without a webhook', async () => {
    const { service, updated } = writable();
    await expectRequestError(
      service.update('app-1', { allowedScopes: [IDENTITY_CHECK_SCOPE] }),
    );
    expect(updated).toHaveLength(0);
  });

  it('turns it on when the webhook is sent in the same update', async () => {
    const { service, updated } = writable();
    await service.update('app-1', {
      allowedScopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhookUrl: 'https://banque.example/hook',
    });
    expect(updated[0]).toEqual({
      allowed_scopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhook_url: 'https://banque.example/hook',
    });
  });

  it('refuses to clear the webhook while the switch stays on', async () => {
    const { service } = writable({
      allowed_scopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhook_url: 'https://banque.example/hook',
    });
    await expectRequestError(service.update('app-1', { webhookUrl: '' }));
  });

  it('allows clearing the webhook together with the switch', async () => {
    const { service, updated } = writable({
      allowed_scopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhook_url: 'https://banque.example/hook',
    });
    await service.update('app-1', {
      allowedScopes: ['openid'],
      webhookUrl: null,
    });
    expect(updated[0]).toEqual({
      allowed_scopes: ['openid'],
      webhook_url: null,
    });
  });

  it('leaves the webhook alone on an unrelated update', async () => {
    const { service, updated } = writable();
    await service.update('app-1', { name: 'Renamed' });
    expect(updated[0]).toEqual({ name: 'Renamed' });
  });

  it('refuses plain http for a real app', async () => {
    const { service } = writable({ is_sandbox: false });
    await expectRequestError(
      service.update('app-1', { webhookUrl: 'http://localhost:4000/hook' }),
    );
  });

  it('registers an identity-check-only app without redirect URIs', async () => {
    const { service, created } = writable();
    await service.create({
      ...base,
      redirectUris: [],
      allowedScopes: [IDENTITY_CHECK_SCOPE],
      webhookUrl: 'https://banque.example/hook',
    });
    expect(created[0]).toEqual(expect.objectContaining({ redirect_uris: [] }));
  });

  it('still requires a redirect URI for a login app', async () => {
    const { service, created } = writable();
    await expectRequestError(service.create({ ...base, redirectUris: [' '] }));
    expect(created).toHaveLength(0);
  });

  it('refuses turning the switch off while the app has no redirect URI', async () => {
    const { service, updated } = writable({
      allowed_scopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhook_url: 'https://banque.example/hook',
      redirect_uris: [],
    });
    await expectRequestError(
      service.update('app-1', { allowedScopes: ['openid'], webhookUrl: null }),
    );
    expect(updated).toHaveLength(0);
  });

  it('allows clearing redirect URIs once the switch is on', async () => {
    const { service, updated } = writable({
      allowed_scopes: ['openid', IDENTITY_CHECK_SCOPE],
      webhook_url: 'https://banque.example/hook',
    });
    await service.update('app-1', { redirectUris: [] });
    expect(updated[0]).toEqual({ redirect_uris: [] });
  });
});

describe('validateWebhookUrl', () => {
  it.each([
    ['https://partner.example/hook', false],
    ['https://partner.example:8443/hook?x=1', false],
    ['http://localhost:4000/hook', true],
    ['http://127.0.0.1/hook', true],
  ])('accepts %s (sandbox=%s)', (url, sandbox) => {
    expect(validateWebhookUrl(url, sandbox)).toBeNull();
  });

  it.each([
    ['http://partner.example/hook', true],
    ['http://localhost:4000/hook', false],
    ['ftp://partner.example/hook', false],
    ['https://user:pass@partner.example/hook', false],
    ['https://partner.example/hook#frag', false],
    ['not a url', false],
    [`https://partner.example/${'a'.repeat(2100)}`, false],
  ])('refuses %s (sandbox=%s)', (url, sandbox) => {
    expect(validateWebhookUrl(url, sandbox)).toEqual(expect.any(String));
  });
});
