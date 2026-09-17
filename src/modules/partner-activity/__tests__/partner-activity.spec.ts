import {
  BadRequestException,
  HttpException,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityCheckStatus, PartnerApiCallKind } from '@prisma/client';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { QueueService } from '../../../common/services/queue/queue.service';
import { OAuthError } from '../../oauth/oauth-error';
import { AdminOAuthAppController } from '../../oauth/admin-oauth-app.controller';
import {
  PartnerApiCall,
  type PartnerLogRequest,
} from '../partner-api-call.decorator';
import { PartnerRequestLogInterceptor } from '../partner-request-log.interceptor';
import {
  PartnerRequestLogService,
  TIMELINE_DAYS,
  describeError,
} from '../partner-request-log.service';
import { summarizeRequest, summarizeResponse } from '../summaries';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('summaries', () => {
  it('keeps only safe token fields', () => {
    const request = summarizeRequest(PartnerApiCallKind.TOKEN, {
      grant_type: 'authorization_code',
      code: 'secret-code',
      code_verifier: 'verifier',
      redirect_uri: 'https://p.example/cb',
      client_id: 'rbk_x',
      client_secret: 'rbk_sk_secret',
    });
    expect(request).toEqual({
      grant_type: 'authorization_code',
      redirect_uri: 'https://p.example/cb',
    });

    const response = summarizeResponse(PartnerApiCallKind.TOKEN, {
      access_token: 'rbk_at_token',
      id_token: 'eyJ.x.y',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid phone',
    });
    expect(response).toEqual({ scope: 'openid phone', expires_in: 3600 });
    expect(JSON.stringify(response)).not.toMatch(/rbk_at|eyJ/);
  });

  it('lists userinfo claim names, never their values', () => {
    expect(
      summarizeResponse(PartnerApiCallKind.USERINFO, {
        sub: 'abc',
        phone_number: '+242061234567',
        name: 'Jean Mabiala',
      }),
    ).toEqual({ claims: ['name', 'phone_number', 'sub'] });
  });

  it('masks the phone and names which identity fields were sent', () => {
    const request = summarizeRequest(PartnerApiCallKind.IDENTITY_CHECK_CREATE, {
      phone: '+242 06 123 4567',
      first_name: 'Jean',
      last_name: 'Mabiala',
      city: '',
      reference: 'loan-1',
    });
    expect(request).toEqual({
      phone: '••67',
      fields_sent: ['first_name', 'last_name', 'reference'],
      reference: 'loan-1',
    });
    expect(JSON.stringify(request)).not.toMatch(/Jean|Mabiala|1234/);
  });

  it('summarizes an identity check read', () => {
    expect(
      summarizeRequest(PartnerApiCallKind.IDENTITY_CHECK_READ, undefined, {
        id: 'check-1',
      }),
    ).toEqual({ check_id: 'check-1' });
    expect(
      summarizeResponse(PartnerApiCallKind.IDENTITY_CHECK_READ, {
        id: 'check-1',
        status: 'completed',
        score: 91,
        recommendation: 'accept',
        match: { name: { level: 'strong' } },
      }),
    ).toEqual({ status: 'completed', recommendation: 'accept', score: 91 });
  });
});

describe('describeError', () => {
  it.each([
    [
      new OAuthError('invalid_client', 'Client authentication failed.', 401),
      { status: 401, code: 'invalid_client' },
    ],
    [
      new HttpException(
        { error: 'rate_limited', error_description: 'Slow down.' },
        429,
      ),
      { status: 429, code: 'rate_limited', description: 'Slow down.' },
    ],
    [
      new BadRequestException(['phone must be a string']),
      {
        status: 400,
        code: 'invalid_request',
        description: 'phone must be a string',
      },
    ],
    [new NotFoundException(), { status: 404, code: 'http_404' }],
    [new Error('boom'), { status: 500, code: 'server_error' }],
  ])('maps %p', (error, expected) => {
    expect(describeError(error)).toEqual(expect.objectContaining(expected));
  });
});

function makeService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    oAuthApp: {
      findFirst: jest.fn().mockResolvedValue({ id: 'app-1' }),
    },
    partnerApiRequest: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    identityCheck: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    oAuthAuthorization: { count: jest.fn().mockResolvedValue(0) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  const service = new PartnerRequestLogService(
    prisma as unknown as PrismaService,
    {} as QueueService,
  );
  return { service, prisma };
}

const basic = (id: string) =>
  `Basic ${Buffer.from(`${id}:rbk_sk_x`).toString('base64')}`;

describe('PartnerRequestLogService.record', () => {
  it('writes a success against the app that made the call', async () => {
    const { service, prisma } = makeService();
    const req = {
      headers: {},
      body: {},
      params: {},
      partnerApp: { id: 'app-9' },
    } as unknown as PartnerLogRequest;

    service.record({
      kind: PartnerApiCallKind.IDENTITY_CHECK_CREATE,
      req,
      startedAt: Date.now() - 12,
      statusCode: 202,
      body: { id: 'check-1', status: 'pending_consent' },
    });
    await flush();

    expect(prisma.oAuthApp.findFirst).not.toHaveBeenCalled();
    expect(prisma.partnerApiRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        app_id: 'app-9',
        kind: PartnerApiCallKind.IDENTITY_CHECK_CREATE,
        status_code: 202,
        outcome: 'ok',
        duration_ms: expect.any(Number),
        response: { check_id: 'check-1', status: 'pending_consent' },
      }),
    });
  });

  it('attributes a failed token call to the client id in the header', async () => {
    const { service, prisma } = makeService();
    const req = {
      headers: { authorization: basic('rbk_known') },
      body: { grant_type: 'authorization_code' },
      params: {},
    } as unknown as PartnerLogRequest;

    service.record({
      kind: PartnerApiCallKind.TOKEN,
      req,
      startedAt: Date.now(),
      error: new OAuthError(
        'invalid_client',
        'Client authentication failed.',
        401,
      ),
    });
    await flush();

    expect(prisma.oAuthApp.findFirst).toHaveBeenCalledWith({
      where: { client_id: 'rbk_known' },
      select: { id: true },
    });
    expect(prisma.partnerApiRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        app_id: 'app-1',
        status_code: 401,
        outcome: 'invalid_client',
        response: {
          error: 'invalid_client',
          description: 'Client authentication failed.',
        },
      }),
    });
  });

  it('uses the client id the userinfo handler found', async () => {
    const { service, prisma } = makeService();
    service.record({
      kind: PartnerApiCallKind.USERINFO,
      req: {
        headers: { authorization: 'Bearer rbk_at_x' },
        partnerClientId: 'rbk_from_token',
      } as unknown as PartnerLogRequest,
      startedAt: Date.now(),
      statusCode: 200,
      body: { sub: 's' },
    });
    await flush();
    expect(prisma.oAuthApp.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { client_id: 'rbk_from_token' } }),
    );
  });

  it('skips a call it cannot attribute', async () => {
    const { service, prisma } = makeService({
      oAuthApp: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    service.record({
      kind: PartnerApiCallKind.TOKEN,
      req: {
        headers: { authorization: basic('rbk_unknown') },
        body: {},
      } as unknown as PartnerLogRequest,
      startedAt: Date.now(),
      error: new Error('x'),
    });
    await flush();
    expect(prisma.partnerApiRequest.create).not.toHaveBeenCalled();
  });

  it('never throws when the write fails', async () => {
    const { service, prisma } = makeService();
    prisma.partnerApiRequest.create.mockRejectedValueOnce(new Error('db down'));
    expect(() =>
      service.record({
        kind: PartnerApiCallKind.REVOKE,
        req: { partnerApp: { id: 'a' } } as unknown as PartnerLogRequest,
        startedAt: Date.now(),
        statusCode: 200,
        body: {},
      }),
    ).not.toThrow();
    await flush();
  });
});

describe('PartnerRequestLogService.stats', () => {
  it('returns the figures and a full 30-day timeline', async () => {
    const now = new Date('2026-09-17T10:00:00.000Z');
    const { service, prisma } = makeService();
    prisma.partnerApiRequest.count.mockResolvedValue(12);
    prisma.identityCheck.groupBy.mockResolvedValue([
      { status: IdentityCheckStatus.COMPLETED, _count: { _all: 4 } },
      { status: IdentityCheckStatus.NOT_COMPLETED, _count: { _all: 2 } },
      { status: IdentityCheckStatus.PENDING_CONSENT, _count: { _all: 1 } },
    ]);
    prisma.oAuthAuthorization.count
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(6);
    prisma.identityCheck.count.mockResolvedValue(3);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { day: new Date('2026-09-17T00:00:00.000Z'), count: BigInt(5) },
      ])
      .mockResolvedValueOnce([
        { day: new Date('2026-09-16T00:00:00.000Z'), count: BigInt(2) },
      ]);

    const stats = await service.stats('app-1', now);

    expect(stats).toEqual(
      expect.objectContaining({
        signIns: 12,
        identityChecks: {
          total: 7,
          completed: 4,
          notCompleted: 2,
          pending: 1,
        },
        connectedPeople: 9,
        verifiedConnected: 6,
        verifiedByCheck: 3,
      }),
    );
    expect(stats.timeline).toHaveLength(TIMELINE_DAYS);
    expect(stats.timeline[0].date).toBe('2026-08-19');
    expect(stats.timeline.at(-1)).toEqual({
      date: '2026-09-17',
      signIns: 5,
      identityChecks: 0,
    });
    expect(stats.timeline.at(-2)).toEqual({
      date: '2026-09-16',
      signIns: 0,
      identityChecks: 2,
    });
    expect(prisma.identityCheck.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: IdentityCheckStatus.COMPLETED,
        result: { path: ['kyc', 'status'], equals: 'verified' },
      }),
    });
  });
});

describe('PartnerRequestLogService.prune', () => {
  it('deletes rows older than 90 days in batches', async () => {
    const { service, prisma } = makeService();
    prisma.partnerApiRequest.findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
    prisma.partnerApiRequest.deleteMany.mockResolvedValue({ count: 2 });

    const now = new Date('2026-09-17T00:00:00.000Z');
    await expect(service.prune(now)).resolves.toEqual({ deleted: 2 });
    expect(prisma.partnerApiRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { created_at: { lt: new Date('2026-06-19T00:00:00.000Z') } },
      }),
    );
  });
});

describe('PartnerRequestLogInterceptor', () => {
  class Target {
    @PartnerApiCall(PartnerApiCallKind.IDENTITY_CHECK_CREATE)
    create() {}
    plain() {}
  }
  // @HttpCode(202) on the real handler.
  Reflect.defineMetadata('__httpCode__', 202, Target.prototype.create);

  function setup(handler: () => void) {
    const log = { record: jest.fn() };
    const interceptor = new PartnerRequestLogInterceptor(
      new Reflector(),
      log as unknown as PartnerRequestLogService,
    );
    const req = { method: 'POST' };
    const context = {
      getHandler: () => handler,
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { interceptor, context, log, req };
  }

  it('records a success with the handler’s status code', async () => {
    const { interceptor, context, log } = setup(Target.prototype.create);
    const next: CallHandler = { handle: () => of({ id: 'c1' }) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).resolves.toEqual({ id: 'c1' });
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: PartnerApiCallKind.IDENTITY_CHECK_CREATE,
        statusCode: 202,
        body: { id: 'c1' },
      }),
    );
  });

  it('records a failure and rethrows it unchanged', async () => {
    const { interceptor, context, log } = setup(Target.prototype.create);
    const error = new OAuthError('invalid_request', 'x', 400);
    const next: CallHandler = { handle: () => throwError(() => error) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBe(error);
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ error }));
  });

  it('ignores handlers without the marker', async () => {
    const { interceptor, context, log } = setup(Target.prototype.plain);
    await lastValueFrom(
      interceptor.intercept(context, { handle: () => of('x') }),
    );
    expect(log.record).not.toHaveBeenCalled();
  });
});

describe('AdminOAuthAppController activity endpoints', () => {
  function controller(appExists: boolean) {
    const prisma = {
      oAuthApp: {
        findFirst: jest
          .fn()
          .mockResolvedValue(appExists ? { id: 'app-1' } : null),
      },
    } as unknown as PrismaService;
    const activity = {
      stats: jest.fn().mockResolvedValue({ signIns: 1 }),
      list: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };
    return {
      activity,
      controller: new AdminOAuthAppController(
        {} as never,
        prisma,
        {} as never,
        {} as never,
        activity as unknown as PartnerRequestLogService,
      ),
    };
  }

  it('returns the stats of an existing app', async () => {
    const { controller: c, activity } = controller(true);
    await expect(c.stats('app-1')).resolves.toEqual({ signIns: 1 });
    expect(activity.stats).toHaveBeenCalledWith('app-1');
  });

  it('pages the request log with defaults', async () => {
    const { controller: c, activity } = controller(true);
    await expect(c.requests('app-1', {})).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    expect(activity.list).toHaveBeenCalledWith('app-1', {
      page: 1,
      limit: 20,
      kind: undefined,
    });
  });

  it('answers 404 for an unknown or deleted app', async () => {
    const { controller: c } = controller(false);
    await expect(c.stats('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(c.requests('nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
