import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';

function makeContext(
  token?: string,
  authHeader?: string,
  overrides?: Partial<Record<string, unknown>>,
): ExecutionContext {
  const request: Record<string, unknown> = {
    cookies: token ? { 'auth-token': token } : {},
    headers: authHeader ? { authorization: authHeader } : {},
    ...overrides,
  };
  const response = { clearCookie: jest.fn() };

  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

/** The `clearCookie` spy on the response `makeContext` built. */
function clearCookieSpy(ctx: ExecutionContext): jest.Mock {
  return ctx.switchToHttp().getResponse<{ clearCookie: jest.Mock }>()
    .clearCookie;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: jest.Mocked<JwtService>;
  let configService: jest.Mocked<ConfigService>;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    jwtService = {
      verify: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return 'test-secret';
        if (key === 'AUTH_COOKIE_NAME') return 'auth-token';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<Reflector>;

    const redis = { get: jest.fn().mockResolvedValue(null) } as any;
    guard = new JwtAuthGuard(jwtService, configService, reflector, redis);
  });

  it('allows public routes without a token', async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
    const ctx = makeContext();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('authenticates profile user from cookie', async () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      sub: 'profile-1',
      type: 'profile',
    });

    const ctx = makeContext('valid-token');
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    const req = ctx
      .switchToHttp()
      .getRequest<{ user: { profileId: string; type: string } }>();
    expect(req.user.profileId).toBe('profile-1');
    expect(req.user.type).toBe('profile');
  });

  it('authenticates admin user from bearer token', async () => {
    (jwtService.verify as jest.Mock).mockReturnValue({
      sub: 'admin-1',
      type: 'admin',
    });

    const ctx = makeContext(undefined, 'Bearer valid-admin-token');
    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    const req = ctx
      .switchToHttp()
      .getRequest<{ user: { userId: string; type: string } }>();
    expect(req.user.userId).toBe('admin-1');
    expect(req.user.type).toBe('admin');
  });

  it('throws UnauthorizedException when no token', async () => {
    const ctx = makeContext();
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when token is invalid', async () => {
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid token');
    });

    const ctx = makeContext('bad-token');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('drops the cookie it just refused', async () => {
    // Nothing on the client can do this — the cookie is httpOnly — so without
    // it the browser resends a dead session on every request, forever.
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new Error('jwt expired');
    });

    const ctx = makeContext('expired-token');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

    expect(clearCookieSpy(ctx)).toHaveBeenCalledWith(
      'auth-token',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
  });

  it('leaves the response alone for a rejected bearer token', async () => {
    // Mobile sends no cookie; there is nothing to clear and no reason to put a
    // Set-Cookie header on its 401.
    (jwtService.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid token');
    });

    const ctx = makeContext(undefined, 'Bearer bad-token');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

    expect(clearCookieSpy(ctx)).not.toHaveBeenCalled();
  });

  it('defaults type to "profile" when payload.type is missing', async () => {
    (jwtService.verify as jest.Mock).mockReturnValue({ sub: 'profile-1' });

    const ctx = makeContext('token');
    await guard.canActivate(ctx);

    const req = ctx.switchToHttp().getRequest<{ user: { type: string } }>();
    expect(req.user.type).toBe('profile');
  });
});
