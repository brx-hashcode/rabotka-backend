import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import { AgentAuthGuard } from '../guards/agent-auth.guard';

function makeContext(headers: Record<string, string> = {}, cookies = {}) {
  const request: Record<string, unknown> = { headers, cookies };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

describe('AgentAuthGuard', () => {
  let jwt: { verify: jest.Mock };
  let redis: { get: jest.Mock };
  let prisma: { agent: { findUnique: jest.Mock } };
  let guard: AgentAuthGuard;

  beforeEach(() => {
    jwt = {
      verify: jest
        .fn()
        .mockReturnValue({ sub: 'agent-1', type: 'agent', jti: 'j1' }),
    };
    redis = { get: jest.fn().mockResolvedValue(null) };
    prisma = {
      agent: {
        findUnique: jest.fn().mockResolvedValue({ status: AgentStatus.ACTIVE }),
      },
    };
    const config = { get: jest.fn().mockReturnValue('secret') };
    guard = new AgentAuthGuard(
      jwt as any,
      config as any,
      prisma as any,
      redis as any,
    );
  });

  it('admits an active agent and records who they are', async () => {
    const { ctx, request } = makeContext({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.agent).toEqual({ agentId: 'agent-1' });
  });

  it('reads the Bearer header only, never a session cookie', async () => {
    // An agent also logged into the worker web app carries that cookie; it
    // must not stand in for the agent token.
    const { ctx } = makeContext({}, { 'auth-token': 'profile-cookie' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it.each(['profile', 'admin', 'agent_refresh', undefined])(
    'refuses a %p token',
    async (type) => {
      jwt.verify.mockReturnValue({ sub: 'x', type });
      const { ctx } = makeContext({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );

  it('refuses an invalid or expired token', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const { ctx } = makeContext({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a revoked session', async () => {
    redis.get.mockResolvedValue('1');
    const { ctx } = makeContext({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('refuses an agent that no longer exists', async () => {
    prisma.agent.findUnique.mockResolvedValue(null);
    const { ctx } = makeContext({ authorization: 'Bearer t' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it.each([AgentStatus.SUSPENDED, AgentStatus.REVOKED])(
    'locks out a %s agent on their very next request',
    async (status) => {
      prisma.agent.findUnique.mockResolvedValue({ status });
      const { ctx } = makeContext({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    },
  );
});
