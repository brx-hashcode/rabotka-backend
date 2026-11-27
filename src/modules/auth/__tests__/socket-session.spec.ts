import { ProfileChatGateway } from '../../profile-chat/profile-chat.gateway';
import { memberRoom, socketProfile } from '../socket-session';

const live = {
  status: 'ACTIVE',
  business: { profile_id: 'biz', deleted_at: null },
};

function deps(
  opts: { revoked?: boolean; archived?: boolean; member?: unknown } = {},
) {
  const redis = {
    get: jest.fn((key: string) => {
      if (key.includes('jwtblocklist:'))
        return Promise.resolve(opts.revoked ? '1' : null);
      if (key.includes('profile-archived:'))
        return Promise.resolve(opts.archived ? '1' : null);
      return Promise.resolve(null);
    }),
  };
  const prisma = {
    businessMember: {
      findUnique: jest
        .fn()
        .mockResolvedValue('member' in opts ? opts.member : live),
    },
  };
  return { redis, prisma };
}

describe('socketProfile', () => {
  it('gives the profile of a live profile session', async () => {
    const { redis, prisma } = deps();
    await expect(
      socketProfile(redis, prisma as never, {
        sub: 'p1',
        type: 'profile',
        jti: 'j',
      }),
    ).resolves.toBe('p1');
  });

  it('refuses an admin token, a signed-out session and an archived profile', async () => {
    const payload = { sub: 'p1', jti: 'j' };
    const a = deps();
    await expect(
      socketProfile(a.redis, a.prisma as never, { ...payload, type: 'admin' }),
    ).resolves.toBeNull();
    const r = deps({ revoked: true });
    await expect(
      socketProfile(r.redis, r.prisma as never, payload),
    ).resolves.toBeNull();
    const z = deps({ archived: true });
    await expect(
      socketProfile(z.redis, z.prisma as never, payload),
    ).resolves.toBeNull();
  });

  it('lets a team member in only while ACTIVE in that live business', async () => {
    const payload = { sub: 'biz', type: 'profile', jti: 'j', mid: 'm1' };
    const ok = deps();
    await expect(
      socketProfile(ok.redis, ok.prisma as never, payload),
    ).resolves.toBe('biz');
    for (const member of [
      null,
      { ...live, status: 'REMOVED' },
      { ...live, status: 'INVITED' },
      { ...live, business: { profile_id: 'other', deleted_at: null } },
      { ...live, business: { profile_id: 'biz', deleted_at: new Date() } },
    ]) {
      const d = deps({ member });
      await expect(
        socketProfile(d.redis, d.prisma as never, payload),
      ).resolves.toBeNull();
    }
  });
});

describe('a removed team member', () => {
  it('loses their sockets, and only theirs', () => {
    const gateway = new ProfileChatGateway(
      { verify: jest.fn() } as never,
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn().mockReturnValue({ disconnectSockets });
    gateway.server = { in: inRoom } as never;

    gateway.evictEndedSession({ kind: 'member', id: 'm1' });

    expect(inRoom).toHaveBeenCalledWith(memberRoom('m1'));
    expect(inRoom).not.toHaveBeenCalledWith('profile:biz');
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });
});
