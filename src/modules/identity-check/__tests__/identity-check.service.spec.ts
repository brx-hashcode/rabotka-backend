import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  DocumentType,
  IdentityCheckStatus,
  VerificationStatus,
  type IdentityCheck,
} from '@prisma/client';
import type Redis from 'ioredis';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { QueueService } from '../../../common/services/queue/queue.service';
import type { WhatsAppService } from '../../whatsapp/whatsapp.service';
import type { WhatsAppLoginLinkService } from '../../auth/whatsapp-login-link.service';
import type { LogService } from '../../log/log.service';
import { OAuthSandboxService } from '../../oauth/services/oauth-sandbox.service';
import type { OAuthAppRow } from '../../oauth/services/oauth-app.service';
import { IdentityCheckService } from '../identity-check.service';
import {
  APP_CHECKS_PER_MINUTE,
  MAX_CONSENT_REQUESTS_PER_PHONE_PER_DAY,
} from '../identity-check.constants';
import type { CreateIdentityCheckDto } from '../dto';

const APP = {
  id: 'app-1',
  client_id: 'rbk_app1',
  is_sandbox: false,
} as OAuthAppRow;
const SANDBOX_APP = { ...APP, id: 'app-sb', is_sandbox: true } as OAuthAppRow;

const DTO: CreateIdentityCheckDto = {
  phone: '+242 06 123 4567',
  first_name: 'Jean',
  last_name: 'Mabiala',
  country_code: 'cg',
};

function row(overrides: Partial<IdentityCheck> = {}): IdentityCheck {
  return {
    id: 'check-1',
    app_id: APP.id,
    profile_id: null,
    sandbox_subject: null,
    phone_e164: '+242061234567',
    claimed: {
      firstName: 'Jean',
      lastName: 'Mabiala',
      countryCode: 'CG',
      city: null,
      documentType: null,
    },
    reference: null,
    idempotency_key: null,
    status: IdentityCheckStatus.PENDING_CONSENT,
    expires_at: new Date(Date.now() + 60_000),
    consent_sent_at: null,
    decided_at: null,
    declined: null,
    result: null,
    score: null,
    webhook_attempts: 0,
    webhook_delivered_at: null,
    webhook_last_error: null,
    created_at: new Date('2026-09-16T10:00:00.000Z'),
    updated_at: new Date('2026-09-16T10:00:00.000Z'),
    ...overrides,
  };
}

function setup() {
  const queueAdd = jest.fn().mockResolvedValue({ id: 'job' });
  const prisma = {
    profile: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
    },
    identityCheck: {
      create: jest.fn(({ data }: { data: Partial<IdentityCheck> }) =>
        Promise.resolve(row({ ...data })),
      ),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const redis = {
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
  const whatsApp = {
    isServiceWindowOpen: jest.fn().mockResolvedValue({ open: false }),
    sendTemplateMessage: jest.fn().mockResolvedValue(true),
    sendInteractiveCta: jest.fn().mockResolvedValue(true),
  };
  const loginLink = {
    mint: jest.fn().mockResolvedValue('CODE'),
    shortLink: jest.fn().mockResolvedValue('https://rabotka.work/s/CODE'),
  };
  const logs = { create: jest.fn().mockResolvedValue(undefined) };
  const sandbox = new OAuthSandboxService({
    get: () => 'salt',
  } as unknown as ConfigService);

  const service = new IdentityCheckService(
    prisma as unknown as PrismaService,
    { getQueue: () => ({ add: queueAdd }) } as unknown as QueueService,
    redis as unknown as Redis,
    whatsApp as unknown as WhatsAppService,
    loginLink as unknown as WhatsAppLoginLinkService,
    logs as unknown as LogService,
    sandbox,
  );

  return { service, prisma, redis, whatsApp, loginLink, logs, queueAdd };
}

async function httpError(promise: Promise<unknown>) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HttpException);
  const error = caught as HttpException;
  return {
    status: error.getStatus(),
    body: error.getResponse() as { error: string },
  };
}

describe('IdentityCheckService.create', () => {
  it('answers a known and an unknown number identically', async () => {
    const unknown = setup();
    const known = setup();
    known.prisma.profile.findFirst.mockResolvedValue({ id: 'profile-1' });

    const a = await unknown.service.create(APP, DTO, undefined, {});
    const b = await known.service.create(APP, DTO, undefined, {});

    const strip = (v: Record<string, unknown>) => ({
      ...v,
      expires_at: undefined,
    });
    expect(strip(a)).toEqual(strip(b));
    expect(a.status).toBe('pending_consent');
    expect(Object.keys(a).sort()).toEqual(
      [
        'completed_at',
        'created_at',
        'expires_at',
        'id',
        'reference',
        'status',
      ].sort(),
    );

    // Both enqueue the consent job, so neither answers faster.
    expect(unknown.queueAdd).toHaveBeenCalledWith(
      'send_consent',
      expect.anything(),
    );
    expect(known.queueAdd).toHaveBeenCalledWith(
      'send_consent',
      expect.anything(),
    );
  });

  it('normalises the phone and looks it up in both stored spellings', async () => {
    const { service, prisma } = setup();
    await service.create(APP, DTO, undefined, {});

    expect(prisma.profile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone: { in: ['+242061234567', '242061234567'] },
          deleted_at: null,
          status: { not: AccountStatus.BANNED },
        }),
      }),
    );
    expect(prisma.identityCheck.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        phone_e164: '+242061234567',
        claimed: expect.objectContaining({ countryCode: 'CG' }),
      }),
    });
  });

  it('refuses a number without a country code', async () => {
    const { service, prisma } = setup();
    const { status, body } = await httpError(
      service.create(APP, { ...DTO, phone: '+06' }, undefined, {}),
    );
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_phone');
    expect(prisma.identityCheck.create).not.toHaveBeenCalled();
  });

  it('stops sending consent requests past the daily cap, silently', async () => {
    const { service, prisma } = setup();
    prisma.profile.findFirst.mockResolvedValue({ id: 'profile-1' });
    prisma.identityCheck.count.mockResolvedValue(
      MAX_CONSENT_REQUESTS_PER_PHONE_PER_DAY,
    );

    const view = await service.create(APP, DTO, undefined, {});

    expect(view.status).toBe('pending_consent');
    expect(prisma.identityCheck.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ profile_id: null }),
    });
  });

  it('rate-limits per app', async () => {
    const { service, redis, prisma } = setup();
    redis.incr.mockResolvedValue(APP_CHECKS_PER_MINUTE + 1);

    const { status, body } = await httpError(
      service.create(APP, DTO, undefined, {}),
    );
    expect(status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(prisma.identityCheck.create).not.toHaveBeenCalled();
  });

  it('returns the original check for a repeated Idempotency-Key', async () => {
    const { service, prisma } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue(
      row({ id: 'original', idempotency_key: 'k1' }),
    );

    const view = await service.create(APP, DTO, 'k1', {});

    expect(view.id).toBe('original');
    expect(prisma.identityCheck.create).not.toHaveBeenCalled();
  });

  it('refuses a reused Idempotency-Key for another number', async () => {
    const { service, prisma } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue(
      row({ idempotency_key: 'k1', phone_e164: '+242069999999' }),
    );

    const { status } = await httpError(service.create(APP, DTO, 'k1', {}));
    expect(status).toBe(409);
  });

  it('never looks up real profiles for a sandbox app', async () => {
    const { service, prisma } = setup();
    await service.create(SANDBOX_APP, DTO, undefined, {});
    expect(prisma.profile.findFirst).not.toHaveBeenCalled();
  });
});

describe('IdentityCheckService.getForApp', () => {
  it('does not show one app another app’s check', async () => {
    const { service, prisma } = setup();
    const { status } = await httpError(service.getForApp(APP, 'check-1'));

    expect(status).toBe(404);
    expect(prisma.identityCheck.findFirst).toHaveBeenCalledWith({
      where: { id: 'check-1', app_id: APP.id },
    });
  });

  it('closes an expired check on read and schedules its webhook', async () => {
    const { service, prisma, queueAdd } = setup();
    prisma.identityCheck.findFirst.mockResolvedValue(
      row({ expires_at: new Date(Date.now() - 1000) }),
    );
    prisma.identityCheck.findUniqueOrThrow.mockResolvedValue(
      row({ status: IdentityCheckStatus.NOT_COMPLETED }),
    );

    const view = await service.getForApp(APP, 'check-1');

    expect(view.status).toBe('not_completed');
    expect(queueAdd).toHaveBeenCalledWith(
      'deliver_webhook',
      { type: 'deliver_webhook', checkId: 'check-1' },
      expect.objectContaining({ jobId: 'webhook-check-1' }),
    );
  });

  it('hides whether a finished check was declined or ignored', async () => {
    const { service, prisma } = setup();
    prisma.identityCheck.findFirst.mockResolvedValue(
      row({
        status: IdentityCheckStatus.NOT_COMPLETED,
        declined: true,
        decided_at: new Date(),
      }),
    );

    const view = await service.getForApp(APP, 'check-1');
    expect(view.status).toBe('not_completed');
    expect(view.completed_at).toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/declin/);
  });
});

describe('IdentityCheckService approve / decline', () => {
  const profileRow = {
    first_name: 'Jean',
    last_name: 'Mabiala',
    country_code: 'CG',
    city: 'Brazzaville',
    verification_status: VerificationStatus.VERIFIED,
    verified_at: new Date('2026-05-01T00:00:00.000Z'),
    status: AccountStatus.ACTIVE,
    kyc_documents: [{ document_type: DocumentType.PASSPORT }],
  };

  function withPending() {
    const ctx = setup();
    const pending = row({ profile_id: 'profile-1' });
    ctx.prisma.identityCheck.findFirst.mockImplementation(
      ({ where }: { where: { profile_id?: string } }) =>
        Promise.resolve(where.profile_id === 'profile-1' ? pending : null),
    );
    ctx.prisma.profile.findUniqueOrThrow.mockResolvedValue(profileRow);
    return ctx;
  }

  it('scores the claim, stores it, and schedules the webhook', async () => {
    const { service, prisma, queueAdd } = withPending();
    prisma.identityCheck.findFirst
      .mockResolvedValueOnce(row({ profile_id: 'profile-1' }))
      .mockResolvedValueOnce({
        ...row({
          profile_id: 'profile-1',
          status: IdentityCheckStatus.COMPLETED,
        }),
        app: { name: 'Banque', description: 'x', logo_url: null },
      });

    const view = await service.approve('profile-1', 'check-1', {});

    expect(view.status).toBe('approved');
    const [{ where, data }] = prisma.identityCheck.updateMany.mock.calls[0];
    expect(where).toEqual(
      expect.objectContaining({
        id: 'check-1',
        profile_id: 'profile-1',
        status: IdentityCheckStatus.PENDING_CONSENT,
      }),
    );
    expect(data).toEqual(
      expect.objectContaining({
        status: IdentityCheckStatus.COMPLETED,
        score: 100,
        result: expect.objectContaining({ recommendation: 'accept' }),
      }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'deliver_webhook',
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses anyone but the profile the check was sent to', async () => {
    const { service, prisma } = withPending();
    const { status } = await httpError(
      service.approve('someone-else', 'check-1', {}),
    );
    expect(status).toBe(404);
    expect(prisma.identityCheck.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an expired check', async () => {
    const { service, prisma } = setup();
    prisma.identityCheck.findFirst.mockResolvedValue(
      row({
        profile_id: 'profile-1',
        expires_at: new Date(Date.now() - 1000),
      }),
    );

    const { status, body } = await httpError(
      service.approve('profile-1', 'check-1', {}),
    );
    expect(status).toBe(409);
    expect(body.error).toBe('not_pending');
  });

  it('refuses when the check closed between read and write', async () => {
    const { service, prisma } = withPending();
    prisma.identityCheck.updateMany.mockResolvedValue({ count: 0 });

    const { status } = await httpError(
      service.decline('profile-1', 'check-1', {}),
    );
    expect(status).toBe(409);
  });

  it('records a decline as NOT_COMPLETED', async () => {
    const { service, prisma } = withPending();
    prisma.identityCheck.findFirst
      .mockResolvedValueOnce(row({ profile_id: 'profile-1' }))
      .mockResolvedValueOnce({
        ...row({
          profile_id: 'profile-1',
          status: IdentityCheckStatus.NOT_COMPLETED,
          declined: true,
        }),
        app: { name: 'Banque', description: 'x', logo_url: null },
      });

    const view = await service.decline('profile-1', 'check-1', {});

    expect(view.status).toBe('declined');
    expect(prisma.identityCheck.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        status: IdentityCheckStatus.NOT_COMPLETED,
        declined: true,
      }),
    );
  });
});

describe('IdentityCheckService.sendConsent', () => {
  const pendingWithProfile = () => ({
    ...row({ profile_id: 'profile-1' }),
    app: { name: 'Banque Exemple', is_sandbox: false },
    profile: {
      phone: '+242061234567',
      first_name: 'Jean',
      status: AccountStatus.ACTIVE,
    },
  });

  it('sends the template with a login code onto the consent page', async () => {
    const { service, prisma, whatsApp, loginLink } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue(pendingWithProfile());

    await service.sendConsent('check-1');

    expect(loginLink.mint).toHaveBeenCalledWith(
      'profile-1',
      'identity-checks/check-1',
    );
    expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
      '+242061234567',
      'identityCheckConsent',
      {
        firstName: 'Jean',
        partnerName: 'Banque Exemple',
        path: 'identity-checks/check-1',
        loginCode: 'CODE',
      },
      'profile-1',
    );
    expect(prisma.identityCheck.updateMany).toHaveBeenCalledWith({
      where: { id: 'check-1', consent_sent_at: null },
      data: { consent_sent_at: expect.any(Date) },
    });
  });

  it('uses a free interactive message inside the 24h window', async () => {
    const { service, prisma, whatsApp } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue(pendingWithProfile());
    whatsApp.isServiceWindowOpen.mockResolvedValue({ open: true });

    await service.sendConsent('check-1');

    expect(whatsApp.sendInteractiveCta).toHaveBeenCalledWith(
      '+242061234567',
      expect.objectContaining({ url: 'https://rabotka.work/s/CODE' }),
    );
    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('throws when nothing was sent, so the job retries', async () => {
    const { service, prisma, whatsApp } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue(pendingWithProfile());
    whatsApp.sendTemplateMessage.mockResolvedValue(false);

    await expect(service.sendConsent('check-1')).rejects.toThrow();
    expect(prisma.identityCheck.updateMany).not.toHaveBeenCalled();
  });

  it('sends nothing when the number resolved to no one', async () => {
    const { service, prisma, whatsApp } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue({
      ...row(),
      app: { name: 'Banque', is_sandbox: false },
      profile: null,
    });

    await service.sendConsent('check-1');

    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    expect(prisma.identityCheck.updateMany).not.toHaveBeenCalled();
  });

  it('does not send twice', async () => {
    const { service, prisma, whatsApp } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue({
      ...pendingWithProfile(),
      consent_sent_at: new Date(),
    });

    await service.sendConsent('check-1');
    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('completes a sandbox check for a sandbox number at once', async () => {
    const { service, prisma, whatsApp } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue({
      ...row({
        phone_e164: '+242061111111',
        claimed: { firstName: 'Rabotka', lastName: 'Sandbox' },
      }),
      app: { name: 'Sandbox', is_sandbox: true },
      profile: null,
    });

    await service.sendConsent('check-1');

    expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
    const { data } = prisma.identityCheck.updateMany.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        status: IdentityCheckStatus.COMPLETED,
        sandbox_subject: 'sandbox:verified',
        result: expect.objectContaining({ recommendation: 'accept' }),
      }),
    );
  });

  it('ends a sandbox check for any other number at once', async () => {
    const { service, prisma } = setup();
    prisma.identityCheck.findUnique.mockResolvedValue({
      ...row(),
      app: { name: 'Sandbox', is_sandbox: true },
      profile: null,
    });

    await service.sendConsent('check-1');

    expect(prisma.identityCheck.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: IdentityCheckStatus.NOT_COMPLETED }),
    );
  });
});

describe('IdentityCheckService.sweep', () => {
  it('closes due checks and purges old claims', async () => {
    const { service, prisma, queueAdd } = setup();
    prisma.identityCheck.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prisma.identityCheck.findUniqueOrThrow.mockResolvedValue(row());
    prisma.identityCheck.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 7 });

    const result = await service.sweep();

    expect(result).toEqual({ expired: 2, purged: 7 });
    // Only the check this sweep actually closed gets a webhook.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      'deliver_webhook',
      { type: 'deliver_webhook', checkId: 'a' },
      expect.anything(),
    );
  });
});
