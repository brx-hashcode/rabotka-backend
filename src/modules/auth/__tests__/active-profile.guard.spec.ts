import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { ActiveProfileGuard } from '../guards/active-profile.guard';
import { ACCOUNT_NOT_ACTIVE } from '../../../common/exceptions/account-not-active.exception';

const mockPrisma = {
  profile: { findUnique: jest.fn() },
};

function makeContext(profileId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: profileId ? { profileId } : {} }),
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;
}

describe('ActiveProfileGuard', () => {
  let guard: ActiveProfileGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ActiveProfileGuard(mockPrisma as never);
  });

  it('lets an active profile through', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.ACTIVE,
      suspension_reason: null,
    });

    await expect(guard.canActivate(makeContext('p1'))).resolves.toBe(true);
  });

  it('blocks a suspended profile and hands back the admin’s reason', async () => {
    // The reason is the whole point: "your account is suspended" with no motive
    // leaves the user with nothing to act on.
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.SUSPENDED,
      suspension_reason: 'Trois pénalités impayées',
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: {
        code: ACCOUNT_NOT_ACTIVE,
        accountStatus: AccountStatus.SUSPENDED,
        reason: 'Trois pénalités impayées',
        message: expect.stringContaining('suspendu') as string,
      },
    });
  });

  it('omits the reason key when the suspension has none', async () => {
    // Every suspension predating the suspension_reason column has none.
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.SUSPENDED,
      suspension_reason: null,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: expect.not.objectContaining({ reason: expect.anything() }),
    });
  });

  it('does not tell a banned user to regularise anything', async () => {
    // That would promise a path back that does not exist.
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.BANNED,
      suspension_reason: null,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: {
        accountStatus: AccountStatus.BANNED,
        message: expect.not.stringContaining('régularisée'),
      },
    });
  });

  it('blocks a profile still pending activation', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.PENDING_ACTIVATION,
      suspension_reason: null,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: { accountStatus: AccountStatus.PENDING_ACTIVATION },
    });
  });

  it('refuses when the request carries no profileId', async () => {
    await expect(guard.canActivate(makeContext())).rejects.toThrow(
      ForbiddenException,
    );
    expect(mockPrisma.profile.findUnique).not.toHaveBeenCalled();
  });

  it('refuses when the profile no longer exists', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(makeContext('gone'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('reads only the two columns it needs', async () => {
    // Keeps the guard a single cheap indexed lookup on a hot POST path.
    mockPrisma.profile.findUnique.mockResolvedValue({
      status: AccountStatus.ACTIVE,
      suspension_reason: null,
    });

    await guard.canActivate(makeContext('p1'));

    expect(mockPrisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'p1' },
      select: { status: true, suspension_reason: true },
    });
  });
});
