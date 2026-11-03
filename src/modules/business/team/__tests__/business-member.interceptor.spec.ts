import {
  ForbiddenException,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';

import { BusinessMemberInterceptor } from '../business-member.interceptor';

const ctx = (req: object) =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  }) as unknown as ExecutionContext;

const handler: CallHandler = { handle: () => of('done') };

describe('BusinessMemberInterceptor', () => {
  let prisma: any;
  let team: any;
  let interceptor: BusinessMemberInterceptor;

  const member = (over: object = {}) => ({
    id: 'm-1',
    role: 'REVIEWER',
    status: 'ACTIVE',
    last_seen_at: new Date(),
    business_id: 'b-1',
    business: { profile_id: 'p-1', deleted_at: null },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      businessMember: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      business: { findUnique: jest.fn() },
    };
    team = {
      record: jest.fn().mockResolvedValue(undefined),
      holder: jest.fn().mockResolvedValue({ id: 'owner' }),
    };
    interceptor = new BusinessMemberInterceptor(prisma, team);
  });

  const run = (req: object) =>
    lastValueFrom(interceptor.intercept(ctx(req), handler));

  it('lets a member read', async () => {
    prisma.businessMember.findUnique.mockResolvedValue(member());
    await expect(
      run({
        method: 'GET',
        route: { path: '/api/v1/profile/job-offers/:id/applications' },
        user: { type: 'profile', profileId: 'p-1', memberId: 'm-1' },
      }),
    ).resolves.toBe('done');
  });

  it('refuses what the role does not allow', async () => {
    prisma.businessMember.findUnique.mockResolvedValue(member());
    await expect(
      run({
        method: 'POST',
        route: { path: '/api/v1/job-offers' },
        user: { type: 'profile', profileId: 'p-1', memberId: 'm-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a removed member on its next call, and a token for another business', async () => {
    prisma.businessMember.findUnique.mockResolvedValueOnce(
      member({ status: 'REMOVED' }),
    );
    const req = {
      method: 'GET',
      route: { path: '/api/v1/business/me' },
      user: { type: 'profile', profileId: 'p-1', memberId: 'm-1' },
    };
    await expect(run(req)).rejects.toBeInstanceOf(UnauthorizedException);
    prisma.businessMember.findUnique.mockResolvedValueOnce(
      member({ business: { profile_id: 'someone-else', deleted_at: null } }),
    );
    await expect(run(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logs a member's change with its route and target", async () => {
    prisma.businessMember.findUnique.mockResolvedValue(
      member({ role: 'RECRUITER' }),
    );
    await run({
      method: 'POST',
      route: { path: '/api/v1/job-offers/:id/close' },
      params: { id: 'offer-9' },
      user: { type: 'profile', profileId: 'p-1', memberId: 'm-1' },
    });
    await new Promise((r) => setImmediate(r));
    expect(team.record).toHaveBeenCalledWith(
      'b-1',
      'm-1',
      'POST /job-offers/:id/close',
      'offer-9',
    );
  });

  it("logs the holder's change, and nothing for someone who is not a business", async () => {
    prisma.business.findUnique.mockResolvedValueOnce({
      id: 'b-1',
      deleted_at: null,
    });
    const req = {
      method: 'POST',
      route: { path: '/api/v1/job-offers/:id/republish' },
      params: { id: 'o-1' },
      user: { type: 'profile', profileId: 'p-1' },
    };
    await run(req);
    await new Promise((r) => setImmediate(r));
    expect(team.record).toHaveBeenCalledWith(
      'b-1',
      'owner',
      'POST /job-offers/:id/republish',
      'o-1',
    );

    team.record.mockClear();
    prisma.business.findUnique.mockResolvedValueOnce(null);
    await run(req);
    await new Promise((r) => setImmediate(r));
    expect(team.record).not.toHaveBeenCalled();
  });

  it('does not log reads, own settings or questions about a CV', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'b-1',
      deleted_at: null,
    });
    for (const [method, path] of [
      ['GET', '/api/v1/business/me'],
      ['PATCH', '/api/v1/business/me/member'],
      ['POST', '/api/v1/business/me/cv-screenings/:id/resumes/:resumeId/chat'],
    ]) {
      await run({
        method,
        route: { path },
        user: { type: 'profile', profileId: 'p-1' },
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(team.record).not.toHaveBeenCalled();
  });
});
