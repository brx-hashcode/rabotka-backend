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

    it('keeps FINANCE out of the two areas it does not own', async () => {
      // Finance reaches everything an admin does EXCEPT team management and
      // settings, so those two are the whole of the restriction.
      for (const area of ['user', 'admin/system-configs']) {
        activeUser(UserRole.FINANCE);
        await expect(
          guardFor([UserRole.MODERATOR]).canActivate(
            makeContext({ userId: 'u1' }, area, 'GET'),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it('keeps SUPPORT out of the wallet', async () => {
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor(null).canActivate(
          makeContext({ userId: 'u1' }, 'admin/wallet', 'GET'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets SUPPORT write profiles — verification is the job', async () => {
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MODERATOR]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/profiles', 'GET'),
        ),
      ).resolves.toBe(true);

      // Was `read`, which let support open a profile and not verify it.
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.MANAGER]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/profiles', 'PATCH'),
        ),
      ).resolves.toBe(true);
    });

    it('still keeps ADMIN-level actions away from SUPPORT', async () => {
      // `POST admin/profiles/:id/wallet/credit` is @Roles(ADMIN). The area is
      // theirs, but the lateral cap is what stops them crediting an account —
      // which is why widening the map to `full` did not widen this.
      activeUser(UserRole.SUPPORT);
      await expect(
        guardFor([UserRole.ADMIN]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/profiles', 'POST'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets both lateral roles read the dashboard', async () => {
      for (const role of [UserRole.SUPPORT, UserRole.FINANCE]) {
        activeUser(role);
        await expect(
          guardFor([UserRole.MODERATOR]).canActivate(
            makeContext({ userId: 'u1' }, 'admin/dashboard', 'GET'),
          ),
        ).resolves.toBe(true);
      }
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

    it('caps SUPPORT at MANAGER inside an area it fully owns', async () => {
      // The ceiling, not the area map, is what keeps permanent deletion and
      // money movement away from support — which is why granting `full` on
      // profiles did not also grant these.
      for (const gate of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        activeUser(UserRole.SUPPORT);
        await expect(
          guardFor([gate]).canActivate(
            makeContext({ userId: 'u1' }, 'admin/profiles', 'POST'),
          ),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it('lets FINANCE pass ADMIN and SUPER_ADMIN gates in its own areas', async () => {
      // Finance is deliberately near-total: inside the areas it owns it acts at
      // any level, permanent purge included. It is restricted by which areas it
      // has, not by what it may do within them.
      for (const gate of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        activeUser(UserRole.FINANCE);
        await expect(
          guardFor([gate]).canActivate(
            makeContext({ userId: 'u1' }, 'admin/wallet', 'POST'),
          ),
        ).resolves.toBe(true);
      }
    });

    it('still refuses FINANCE at a SUPER_ADMIN gate OUTSIDE its areas', async () => {
      // The ceiling is lifted, the allowlist is not.
      activeUser(UserRole.FINANCE);
      await expect(
        guardFor([UserRole.SUPER_ADMIN]).canActivate(
          makeContext({ userId: 'u1' }, 'user', 'POST'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets SUPER_ADMIN through every gate, on any controller', async () => {
      // SUPER_ADMIN is the top of the ladder, so `userLevel >= requiredLevel`
      // holds for every gate — including a controller nobody has added to any
      // map yet, since the lateral allowlist is consulted only for lateral
      // roles. Asserted rather than assumed: this is the property most easily
      // broken by accident.
      const gates = [
        null,
        [UserRole.MODERATOR],
        [UserRole.MANAGER],
        [UserRole.ADMIN],
        [UserRole.SUPER_ADMIN],
      ];
      const paths = [
        'admin/wallet',
        'user',
        'admin/system-configs',
        'admin/some-controller-added-tomorrow',
      ];

      for (const gate of gates) {
        for (const path of paths) {
          activeUser(UserRole.SUPER_ADMIN);
          await expect(
            guardFor(gate).canActivate(
              makeContext({ userId: 'u1' }, path, 'POST'),
            ),
          ).resolves.toBe(true);
        }
      }
    });

    it('documents the one decorator that would lock SUPER_ADMIN out', async () => {
      // `requiredLevel` filters lateral roles out before taking a minimum, so a
      // handler declaring ONLY lateral roles has no ladder meaning and returns
      // Infinity — fail-closed by design, but it denies SUPER_ADMIN too. The
      // invariant is therefore "never write @Roles(FINANCE)", and this test is
      // where that is written down.
      activeUser(UserRole.SUPER_ADMIN);
      await expect(
        guardFor([UserRole.FINANCE]).canActivate(
          makeContext({ userId: 'u1' }, 'admin/wallet', 'GET'),
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
