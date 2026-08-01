import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { VerificationStatus } from '@prisma/client';
import { KycVerifiedGuard } from '../guards/kyc-verified.guard';
import { KYC_NOT_VERIFIED } from '../../../common/exceptions/kyc-not-verified.exception';

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

describe('KycVerifiedGuard', () => {
  let guard: KycVerifiedGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new KycVerifiedGuard(mockPrisma as never);
  });

  it('lets a verified profile through', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      verification_status: VerificationStatus.VERIFIED,
    });

    await expect(guard.canActivate(makeContext('p1'))).resolves.toBe(true);
  });

  it('blocks a pending profile and says a notification is coming', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      verification_status: VerificationStatus.PENDING,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: {
        code: KYC_NOT_VERIFIED,
        verificationStatus: VerificationStatus.PENDING,
        message: expect.stringContaining('notification') as string,
      },
    });
  });

  it('blocks a rejected profile with different copy', async () => {
    // A refused user must never be told to wait for a notification that will
    // never arrive — only an admin can change the decision.
    mockPrisma.profile.findUnique.mockResolvedValue({
      verification_status: VerificationStatus.REJECTED,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: {
        code: KYC_NOT_VERIFIED,
        verificationStatus: VerificationStatus.REJECTED,
        message: expect.stringContaining('support') as string,
      },
    });
  });

  it('does not reuse the pending wording for a rejection', async () => {
    mockPrisma.profile.findUnique.mockResolvedValue({
      verification_status: VerificationStatus.REJECTED,
    });

    await expect(guard.canActivate(makeContext('p1'))).rejects.toMatchObject({
      response: { message: expect.not.stringContaining('notification') },
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

  it('reads only the KYC column', async () => {
    // Keeps the guard a single cheap indexed lookup on a hot POST path.
    mockPrisma.profile.findUnique.mockResolvedValue({
      verification_status: VerificationStatus.VERIFIED,
    });

    await guard.canActivate(makeContext('p1'));

    expect(mockPrisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'p1' },
      select: { verification_status: true },
    });
  });
});
