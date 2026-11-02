import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { BusinessProfileGuard } from '../business-profile.guard';

function contextFor(profileId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: profileId ? { profileId } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(profile: unknown) {
  const prisma = {
    profile: { findUnique: jest.fn().mockResolvedValue(profile) },
  };
  return new BusinessProfileGuard(prisma as never);
}

const business = {
  profile_type: 'EMPLOYER',
  is_business: true,
  deleted_at: null,
  business: { deleted_at: null },
};

describe('BusinessProfileGuard', () => {
  it('lets a business employer through', async () => {
    await expect(
      guardWith(business).canActivate(contextFor('p1')),
    ).resolves.toBe(true);
  });

  it.each([
    ['a regular employer', { ...business, is_business: false }],
    ['a worker', { ...business, profile_type: 'WORKER' }],
    ['an archived profile', { ...business, deleted_at: new Date() }],
    ['a flagged profile without a business', { ...business, business: null }],
    [
      'an archived business',
      { ...business, business: { deleted_at: new Date() } },
    ],
    ['an unknown profile', null],
  ])('refuses %s', async (_label, profile) => {
    await expect(
      guardWith(profile).canActivate(contextFor('p1')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a request without a profile', async () => {
    await expect(guardWith(business).canActivate(contextFor())).rejects.toThrow(
      ForbiddenException,
    );
  });
});
