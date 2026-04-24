import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AdminAuthGuard } from '../guards/admin-auth.guard';

function makeContext(payload: { sub: string; type?: string } | null): ExecutionContext {
  const request: Record<string, unknown> = {
    cookies: { 'auth-token': 'token' },
    headers: {},
  };

  const jwtService = {
    verify: jest.fn().mockReturnValue(payload),
  } as unknown as JwtService;

  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'JWT_SECRET') return 'secret';
      if (key === 'AUTH_COOKIE_NAME') return 'auth-token';
      return undefined;
    }),
  } as unknown as ConfigService;

  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;

  const guard = new AdminAuthGuard(jwtService, configService, reflector, { get: jest.fn().mockResolvedValue(null) } as any);

  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => {
        // Simulate super.canActivate setting req.user
        if (payload) {
          (request as Record<string, unknown>).user = {
            ...(payload.type === 'admin'
              ? { userId: payload.sub }
              : { profileId: payload.sub }),
            type: payload.type ?? 'profile',
          };
        }
        return request;
      },
    }),
  } as unknown as ExecutionContext;

  return { ctx, guard } as unknown as ExecutionContext;
}

describe('AdminAuthGuard', () => {
  let reflector: jest.Mocked<Reflector>;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;

  function buildGuardAndContext(payload: { sub: string; type?: string } | null) {
    const request: Record<string, unknown> = {
      cookies: { 'auth-token': 'token' },
      headers: {},
    };

    jwtService = {
      verify: jest.fn().mockReturnValue(payload),
    } as unknown as jest.Mocked<JwtService>;

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return 'secret';
        if (key === 'AUTH_COOKIE_NAME') return 'auth-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Reflector>;

    const guard = new AdminAuthGuard(jwtService, configService, reflector, { get: jest.fn().mockResolvedValue(null) } as any);

    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => {
          if (payload) {
            request.user = {
              ...(payload.type === 'admin'
                ? { userId: payload.sub }
                : { profileId: payload.sub }),
              type: payload.type ?? 'profile',
            };
          }
          return request;
        },
      }),
    } as unknown as ExecutionContext;

    return { guard, ctx };
  }

  it('allows admin users with valid token', () => {
    const { guard, ctx } = buildGuardAndContext({ sub: 'admin-1', type: 'admin' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws UnauthorizedException when user type is profile', () => {
    const { guard, ctx } = buildGuardAndContext({ sub: 'profile-1', type: 'profile' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when user type is missing userId', () => {
    const request: Record<string, unknown> = {
      cookies: { 'auth-token': 'token' },
      headers: {},
    };

    jwtService = {
      verify: jest.fn().mockReturnValue({ sub: 'admin-1', type: 'admin' }),
    } as unknown as jest.Mocked<JwtService>;

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return 'secret';
        if (key === 'AUTH_COOKIE_NAME') return 'auth-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Reflector>;

    const guard = new AdminAuthGuard(jwtService, configService, reflector, { get: jest.fn().mockResolvedValue(null) } as any);

    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => {
          // Set user without userId (simulating missing field)
          request.user = { type: 'admin' }; // no userId
          return request;
        },
      }),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
