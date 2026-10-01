import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { UnblockedProfileGuard } from '../guards/unblocked-profile.guard';
import {
  ACCOUNT_NOT_ACTIVE,
  AccountNotActiveException,
} from '../../../common/exceptions/account-not-active.exception';

function contextFor(profileId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: profileId ? { profileId } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(profile: unknown) {
  const prisma = {
    profile: { findUnique: jest.fn().mockResolvedValue(profile) },
  };
  return { guard: new UnblockedProfileGuard(prisma as never), prisma };
}

describe('UnblockedProfileGuard', () => {
  it.each([AccountStatus.ACTIVE, AccountStatus.PENDING_ACTIVATION])(
    'lets a %s profile through',
    async (status) => {
      // PENDING_ACTIVATION above all: these routes are how a new account
      // finishes its profile while it waits for KYC.
      const { guard } = guardFor({ status, suspension_reason: null });
      await expect(guard.canActivate(contextFor('p-1'))).resolves.toBe(true);
    },
  );

  it.each([AccountStatus.SUSPENDED, AccountStatus.BANNED])(
    'refuses a %s profile, with the reason',
    async (status) => {
      const { guard } = guardFor({
        status,
        suspension_reason: 'Faux documents',
      });

      const error = await guard
        .canActivate(contextFor('p-1'))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AccountNotActiveException);
      expect((error as AccountNotActiveException).getResponse()).toMatchObject({
        code: ACCOUNT_NOT_ACTIVE,
        accountStatus: status,
        reason: 'Faux documents',
      });
    },
  );

  it('reads the status fresh on every request', async () => {
    const { guard, prisma } = guardFor({
      status: AccountStatus.ACTIVE,
      suspension_reason: null,
    });
    await guard.canActivate(contextFor('p-1'));
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      select: { status: true, suspension_reason: true },
    });
  });

  it('refuses a request with no profile, or a profile that is gone', async () => {
    await expect(
      guardFor(null).guard.canActivate(contextFor(undefined)),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      guardFor(null).guard.canActivate(contextFor('p-gone')),
    ).rejects.toThrow(ForbiddenException);
  });
});
