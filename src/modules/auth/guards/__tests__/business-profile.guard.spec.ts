import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OpenToBlockedBusiness } from '../../decorators/open-to-blocked-business.decorator';
import { BusinessProfileGuard } from '../business-profile.guard';

class Routes {
  write() {}
  @OpenToBlockedBusiness()
  open() {}
}

function contextFor(
  profileId?: string,
  method = 'GET',
  handler: keyof Routes = 'write',
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        user: profileId ? { profileId } : undefined,
      }),
    }),
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
  } as unknown as ExecutionContext;
}

function guardWith(profile: unknown) {
  const prisma = {
    profile: { findUnique: jest.fn().mockResolvedValue(profile) },
  };
  return new BusinessProfileGuard(prisma as never);
}

const business = {
  status: 'ACTIVE',
  suspension_reason: null,
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

  describe('a suspended or banned business', () => {
    it.each(['SUSPENDED', 'BANNED'])(
      'makes no write when %s, its team included',
      async (status) => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          await expect(
            guardWith({ ...business, status }).canActivate(
              contextFor('p1', method),
            ),
          ).rejects.toMatchObject({
            response: { code: 'ACCOUNT_NOT_ACTIVE', accountStatus: status },
          });
        }
      },
    );

    it('still reads its space', async () => {
      await expect(
        guardWith({ ...business, status: 'SUSPENDED' }).canActivate(
          contextFor('p1', 'GET'),
        ),
      ).resolves.toBe(true);
    });

    it('may make a write marked open to it', async () => {
      await expect(
        guardWith({ ...business, status: 'BANNED' }).canActivate(
          contextFor('p1', 'DELETE', 'open'),
        ),
      ).resolves.toBe(true);
    });

    it('lets a pending business write: it completes its file', async () => {
      await expect(
        guardWith({ ...business, status: 'PENDING_ACTIVATION' }).canActivate(
          contextFor('p1', 'POST'),
        ),
      ).resolves.toBe(true);
    });
  });
});
