import { JwtService } from '@nestjs/jwt';
import { callbackSession } from '../connect-session';

const SECRET = 'test-secret';
const jwt = new JwtService({ secret: SECRET });
const config = {
  get: (k: string) => (k === 'JWT_SECRET' ? SECRET : 'rb_at'),
} as never;
const business = {
  profile_type: 'EMPLOYER',
  is_business: true,
  deleted_at: null,
  status: 'ACTIVE',
  verification_status: 'VERIFIED',
  business: { deleted_at: null },
};

function deps(profile: unknown = business) {
  return {
    jwt,
    config,
    redis: { get: jest.fn().mockResolvedValue(null) },
    prisma: {
      profile: { findUnique: jest.fn().mockResolvedValue(profile) },
      businessMember: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          business: { profile_id: 'biz', deleted_at: null },
        }),
      },
    } as never,
  };
}

const bearer = (payload: object) =>
  ({
    headers: { authorization: `Bearer ${jwt.sign(payload)}` },
    cookies: {},
  }) as never;

describe('callbackSession', () => {
  it('is the signed-in holder or member of an approved business', async () => {
    await expect(
      callbackSession(deps(), bearer({ sub: 'biz', type: 'profile' })),
    ).resolves.toEqual({ profileId: 'biz', memberId: null });
    await expect(
      callbackSession(
        deps(),
        bearer({ sub: 'biz', type: 'profile', mid: 'm1' }),
      ),
    ).resolves.toEqual({ profileId: 'biz', memberId: 'm1' });
  });

  it('is nobody without a session, or for a business not approved or blocked', async () => {
    await expect(
      callbackSession(deps(), { headers: {}, cookies: {} } as never),
    ).resolves.toBeNull();
    for (const profile of [
      { ...business, verification_status: 'PENDING' },
      { ...business, status: 'SUSPENDED' },
      { ...business, is_business: false },
    ]) {
      await expect(
        callbackSession(deps(profile), bearer({ sub: 'biz', type: 'profile' })),
      ).resolves.toBeNull();
    }
  });
});
