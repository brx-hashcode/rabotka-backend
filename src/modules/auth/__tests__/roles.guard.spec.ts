import { ForbiddenException } from '@nestjs/common';
import { RolesGuard } from '../guards/roles.guard';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ExecutionContext } from '@nestjs/common';

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
};

function makeReflector(roles: UserRole[] | null) {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(roles),
  } as any;
}

function makeContext(user: any, controllerPath?: string, method = 'GET') {
  class FakeController {}
  if (controllerPath) {
    Reflect.defineMetadata('path', controllerPath, FakeController);
  }
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, method }),
    }),
    getHandler: jest.fn(),
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
}

/** An active user of the given role, for the guard's own lookup. */
function activeUser(role: UserRole) {
  mockPrisma.user.findUnique.mockResolvedValue({ role, is_active: true });
}

describe('RolesGuard', () => {
  it('returns true when no required roles', async () => {
    activeUser(UserRole.MODERATOR);
    const guard = new RolesGuard(makeReflector(null), mockPrisma as any);
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('returns true when required roles is empty', async () => {
    activeUser(UserRole.MODERATOR);
    const guard = new RolesGuard(makeReflector([]), mockPrisma as any);
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('rejects an inactive user even when no roles are declared', async () => {
    // The identity check no longer sits behind the "no @Roles" shortcut, so a
    // deactivated admin cannot keep using an ungated endpoint.
    mockPrisma.user.findUnique.mockResolvedValue({
      role: UserRole.ADMIN,
      is_active: false,
    });
    const guard = new RolesGuard(makeReflector(null), mockPrisma as any);
    await expect(
      guard.canActivate(makeContext({ userId: 'u1' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when no userId', async () => {
    const guard = new RolesGuard(
      makeReflector([UserRole.ADMIN]),
      mockPrisma as any,
    );
    const ctx = makeContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user not found', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const guard = new RolesGuard(
      makeReflector([UserRole.ADMIN]),
      mockPrisma as any,
    );
    const ctx = makeContext({ userId: 'u1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user is inactive', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      role: UserRole.ADMIN,
      is_active: false,
    });
    const guard = new RolesGuard(
      makeReflector([UserRole.ADMIN]),
      mockPrisma as any,
    );
    const ctx = makeContext({ userId: 'u1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user role is insufficient', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      role: UserRole.MODERATOR,
      is_active: true,
    });
    const guard = new RolesGuard(
      makeReflector([UserRole.ADMIN]),
      mockPrisma as any,
    );
    const ctx = makeContext({ userId: 'u1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('returns true when user role meets required level', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      role: UserRole.ADMIN,
      is_active: true,
    });
    const guard = new RolesGuard(
      makeReflector([UserRole.MANAGER]),
      mockPrisma as any,
    );
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('returns true for SUPER_ADMIN with any required role', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      role: UserRole.SUPER_ADMIN,
      is_active: true,
    });
    const guard = new RolesGuard(
      makeReflector([UserRole.MODERATOR]),
      mockPrisma as any,
    );
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  describe('lateral roles', () => {
    const guardFor = (roles: UserRole[] | null) =>
      new RolesGuard(makeReflector(roles), mockPrisma as any);

    it('lets FINANCE into an area it owns', async () => {
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.MANAGER]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/wallet', 'POST'),
        ),
      ).resolves.toBe(true);
    });

    it('keeps FINANCE out of an area it does not own', async () => {
      // The whole point of a lateral role: seniority elsewhere is not implied.
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/claims', 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('keeps SUPPORT out of the wallet', async () => {
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor(null).canActivate(
          makeContext({ userId: 'u1' }, 'admin/wallet', 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets SUPPORT read profiles but not write them', async () => {
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/profiles', 'GET'),
        ),
      ).resolves.toBe(true);

      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/profiles', 'PATCH'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets SUPPORT read feedback but not write it', async () => {
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/feedback', 'GET'),
        ),
      ).resolves.toBe(true);

      // Both endpoints are GET today. The `read` grant is what keeps that true
      // if someone later adds a destructive one to the same controller.
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/feedback', 'DELETE'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('keeps FINANCE out of feedback', async () => {
      // Granted to SUPPORT alone: finance has no reason to read what a worker
      // said about a match.
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/feedback', 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never lets a lateral role pass a SUPER_ADMIN gate in its own area', async () => {
      // Penalties belong to FINANCE, but permanent deletion never does.
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.SUPER_ADMIN]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/penalties', 'POST'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never lets a lateral role pass an ADMIN gate in its own area', async () => {
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.ADMIN]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/wallet', 'POST'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies an endpoint that declares no roles at all', async () => {
      // Fails closed: forgetting @Roles on a new admin controller must not hand
      // lateral roles an area they were never granted.
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor(null).canActivate(
          makeContext({ userId: 'u1' }, 'admin/logs', 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('denies a controller with no path metadata', async () => {
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.MANAGER]).canActivate(
          makeContext({ userId: 'u1' }, undefined, 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
