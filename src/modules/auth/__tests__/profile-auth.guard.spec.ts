import { UnauthorizedException } from '@nestjs/common';
import { ProfileAuthGuard } from '../guards/profile-auth.guard';
import { ExecutionContext } from '@nestjs/common';

function makeGuard(superCanActivateResult: boolean = true) {
  const guard = new ProfileAuthGuard(
    null as any,
    null as any,
    null as any,
    null as any,
  );
  jest
    .spyOn(guard as any, 'canActivate')
    .mockImplementation(async (context: ExecutionContext) => {
      // First call the real logic by bypassing super
      return (guard as any).realCanActivate(context);
    });
  // Override super.canActivate
  Object.getPrototypeOf(Object.getPrototypeOf(guard)).canActivate = jest
    .fn()
    .mockReturnValue(superCanActivateResult);
  return guard;
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

describe('ProfileAuthGuard', () => {
  let guard: ProfileAuthGuard;

  beforeEach(() => {
    guard = new ProfileAuthGuard(
      null as any,
      null as any,
      null as any,
      null as any,
    );
  });

  it('returns false when super.canActivate returns false', async () => {
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(false);
    const ctx = makeContext({ type: 'profile', profileId: 'p1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(false);
  });

  it('throws UnauthorizedException when user type is not profile', async () => {
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    const ctx = makeContext({ type: 'user', userId: 'u1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when profileId is missing', async () => {
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    const ctx = makeContext({ type: 'profile', profileId: null });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('returns true for valid profile user', async () => {
    jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    const ctx = makeContext({ type: 'profile', profileId: 'p1' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });
});
