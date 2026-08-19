import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../guards/admin-auth.guard';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';

type AdminRow = { role: UserRole; is_active: boolean } | null;

/**
 * `account` is what the database returns for the token's subject: a row, or
 * null for an admin who no longer exists.
 */
function buildGuardAndContext(
  payload: { sub: string; type?: string } | null,
  account: AdminRow = { role: UserRole.ADMIN, is_active: true },
) {
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

  const findUnique = jest.fn().mockResolvedValue(account);
  const prisma = { user: { findUnique } } as unknown as PrismaService;

  const guard = new AdminAuthGuard(
    jwtService,
    configService,
    reflector,
    { get: jest.fn().mockResolvedValue(null) } as never,
    prisma,
  );

  const ctx = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => {
        // Simulate super.canActivate setting req.user
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

  return { guard, ctx, request, findUnique };
}

describe('AdminAuthGuard', () => {
  it('allows admin users with valid token', async () => {
    const { guard, ctx } = buildGuardAndContext({
      sub: 'admin-1',
      type: 'admin',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('throws UnauthorizedException when user type is profile', async () => {
    const { guard, ctx } = buildGuardAndContext({
      sub: 'profile-1',
      type: 'profile',
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when user type is missing userId', async () => {
    const request: Record<string, unknown> = {
      cookies: { 'auth-token': 'token' },
      headers: {},
    };

    const { guard } = buildGuardAndContext({ sub: 'admin-1', type: 'admin' });

    const ctx = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => {
          request.user = { type: 'admin' }; // no userId
          return request;
        },
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  /**
   * The reason this check moved out of `RolesGuard`: not every admin route
   * mounts one. `GET log/admin` and seven `auth/admin/*` routes carried
   * `AdminAuthGuard` alone, so a deactivated admin kept access to them for as
   * long as their token stayed valid.
   */
  it('rejects a deactivated admin holding a valid token', async () => {
    const { guard, ctx } = buildGuardAndContext(
      { sub: 'admin-1', type: 'admin' },
      { role: UserRole.ADMIN, is_active: false },
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose admin no longer exists', async () => {
    const { guard, ctx } = buildGuardAndContext(
      { sub: 'admin-1', type: 'admin' },
      null,
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('stashes the account so RolesGuard does not read it again', async () => {
    const { guard, ctx, request } = buildGuardAndContext(
      { sub: 'admin-1', type: 'admin' },
      { role: UserRole.MANAGER, is_active: true },
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.adminAccount).toEqual({
      role: UserRole.MANAGER,
      isActive: true,
    });
  });

  it('reads the role per request rather than trusting the token', async () => {
    const { guard, ctx, findUnique } = buildGuardAndContext({
      sub: 'admin-1',
      type: 'admin',
    });

    await guard.canActivate(ctx);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      select: { role: true, is_active: true },
    });
  });
});
