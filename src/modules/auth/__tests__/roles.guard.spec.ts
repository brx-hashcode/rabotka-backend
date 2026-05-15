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

function makeContext(user: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('returns true when no required roles', async () => {
    const guard = new RolesGuard(makeReflector(null), mockPrisma as any);
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('returns true when required roles is empty', async () => {
    const guard = new RolesGuard(makeReflector([]), mockPrisma as any);
    const ctx = makeContext({ userId: 'u1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
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
});
