import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminOAuthAppController } from '../admin-oauth-app.controller';
import type { OAuthAppService } from '../services/oauth-app.service';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { LogService } from '../../log/log.service';
import type { OAuthSandboxService } from '../services/oauth-sandbox.service';

/**
 * The admin surface of Login with Rabotka, and specifically the one route that
 * hands back a stored credential.
 *
 * There was no spec for this controller until a secret became readable. Until
 * then the guarantee "the list emits only the hint" was held by a hand-written
 * mapper and code review alone; now that a plaintext column exists, that is not
 * enough, and the canary at the bottom of this file is why the file exists.
 */

const PLAINTEXT = 'rbk_sk_readable_value';

const req = {
  adminAccount: { id: 'admin-1' },
  headers: {},
  ip: '127.0.0.1',
  get: () => undefined,
} as never;

function build(
  overrides: {
    readSandboxSecret?: jest.Mock;
    findMany?: jest.Mock;
  } = {},
) {
  const logged: Record<string, unknown>[] = [];

  const apps = {
    readSandboxSecret: overrides.readSandboxSecret ?? jest.fn(),
  } as unknown as OAuthAppService;

  const prisma = {
    oAuthApp: { findMany: overrides.findMany ?? jest.fn() },
  } as unknown as PrismaService;

  const logs = {
    create: jest.fn((entry: Record<string, unknown>) => {
      logged.push(entry);
      return Promise.resolve(undefined);
    }),
  } as unknown as LogService;

  const sandbox = { catalogue: jest.fn() } as unknown as OAuthSandboxService;

  return {
    controller: new AdminOAuthAppController(apps, prisma, logs, sandbox),
    logged,
  };
}

describe('AdminOAuthAppController — reading a sandbox secret', () => {
  it('returns the secret for a sandbox app that has one stored', async () => {
    const { controller, logged } = build({
      readSandboxSecret: jest.fn().mockResolvedValue({
        status: 'ok',
        clientId: 'rbk_abc',
        clientSecret: PLAINTEXT,
      }),
    });

    await expect(controller.readSandboxSecret('app-1', req)).resolves.toEqual({
      clientId: 'rbk_abc',
      clientSecret: PLAINTEXT,
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      action: 'OAUTH_APP_SANDBOX_SECRET_REVEALED',
      entityId: 'app-1',
      userId: 'admin-1',
    });
  });

  it('keeps the secret out of the audit trail', async () => {
    // The trail is what makes a readable credential defensible. A trail that
    // itself contains the credential defeats the point.
    const { controller, logged } = build({
      readSandboxSecret: jest.fn().mockResolvedValue({
        status: 'ok',
        clientId: 'rbk_abc',
        clientSecret: PLAINTEXT,
      }),
    });

    await controller.readSandboxSecret('app-1', req);

    expect(JSON.stringify(logged)).not.toContain(PLAINTEXT);
  });

  /**
   * The single most important test here.
   *
   * The service is made to answer `not_sandbox` for a row that nonetheless
   * carries a plaintext — the exact shape a bad backfill or a manual UPDATE
   * would produce. Nothing about that value may reach the caller.
   */
  it('refuses a REAL application even when a plaintext sits on the row', async () => {
    const { controller } = build({
      readSandboxSecret: jest
        .fn()
        .mockResolvedValue({ status: 'not_sandbox', clientId: 'rbk_live' }),
    });

    await expect(controller.readSandboxSecret('app-1', req)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('answers 404 for a soft-deleted application', async () => {
    const { controller } = build({
      readSandboxSecret: jest.fn().mockResolvedValue({ status: 'not_found' }),
    });

    await expect(controller.readSandboxSecret('app-1', req)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('answers 409 for a sandbox app registered before the column existed', async () => {
    const { controller } = build({
      readSandboxSecret: jest
        .fn()
        .mockResolvedValue({ status: 'not_stored', clientId: 'rbk_abc' }),
    });

    await expect(controller.readSandboxSecret('app-1', req)).rejects.toThrow(
      ConflictException,
    );
  });

  it.each([
    ['not_found', NotFoundException],
    ['not_sandbox', ForbiddenException],
    ['not_stored', ConflictException],
  ])('records the refusal reason %p', async (status, expected) => {
    const { controller, logged } = build({
      readSandboxSecret: jest
        .fn()
        .mockResolvedValue({ status, clientId: 'rbk_abc' }),
    });

    await expect(controller.readSandboxSecret('app-1', req)).rejects.toThrow(
      expected,
    );

    // An attempt to read a live partner's secret is precisely the event
    // someone would go looking for later.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      action: 'OAUTH_APP_SECRET_REVEAL_REFUSED',
      metadata: { reason: status },
    });
  });

  it('inherits SUPER_ADMIN rather than declaring its own roles', () => {
    // A method-level @Roles would OVERRIDE the class-level one. Asserting its
    // absence is what stops someone loosening this route by adding a decorator
    // that looks like it only documents the existing rule.
    const onMethod: unknown = Reflect.getMetadata(
      'roles',
      AdminOAuthAppController.prototype.readSandboxSecret,
    );
    const onClass: unknown = Reflect.getMetadata(
      'roles',
      AdminOAuthAppController,
    );

    expect(onMethod).toBeUndefined();
    expect(onClass).toEqual([UserRole.SUPER_ADMIN]);
  });
});

describe('AdminOAuthAppController — the list never carries a secret', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'app-1',
    name: 'Money Cash',
    description: 'FinTech',
    logo_url: null,
    client_id: 'rbk_abc',
    client_secret_hint: '1a2b',
    client_secret_hash: 'deadbeef',
    sandbox_client_secret_plaintext: null,
    secret_rotated_at: null,
    previous_secret_expires_at: null,
    redirect_uris: ['https://x.test/cb'],
    allowed_scopes: ['openid', 'profile'],
    status: 'ACTIVE',
    is_sandbox: false,
    contact_email: 'dev@x.test',
    creator: null,
    _count: { authorizations: 0 },
    // The mapper reads `authorizations[0]` for the last sign-in.
    authorizations: [],
    created_at: new Date(),
    ...overrides,
  });

  /**
   * The canary. `findMany` asks for the omitted column so `canCopySecret` can
   * be derived, which means the value is in memory when the mapper runs — the
   * mapper is an allowlist, and this asserts it stays one.
   */
  it('drops the plaintext even though the query loads it', async () => {
    const { controller } = build({
      findMany: jest.fn().mockResolvedValue([
        row({
          is_sandbox: true,
          sandbox_client_secret_plaintext: PLAINTEXT,
        }),
      ]),
    });

    const result = await controller.list();

    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(result)).not.toContain('deadbeef');
  });

  it.each([
    ['a sandbox app with a stored secret', true, PLAINTEXT, true],
    ['a sandbox app registered before the column', true, null, false],
    ['a real app', false, null, false],
  ])('reports canCopySecret for %s', async (_label, isSandbox, plain, want) => {
    const { controller } = build({
      findMany: jest.fn().mockResolvedValue([
        row({
          is_sandbox: isSandbox,
          sandbox_client_secret_plaintext: plain,
        }),
      ]),
    });

    const [app] = await controller.list();
    expect(app.canCopySecret).toBe(want);
  });

  it('never reports canCopySecret for a real app carrying a plaintext', async () => {
    // Defence in depth against the same bad-row shape as the 403 test above.
    const { controller } = build({
      findMany: jest.fn().mockResolvedValue([
        row({
          is_sandbox: false,
          sandbox_client_secret_plaintext: PLAINTEXT,
        }),
      ]),
    });

    const [app] = await controller.list();
    expect(app.canCopySecret).toBe(false);
  });
});
