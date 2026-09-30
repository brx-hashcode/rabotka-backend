import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClaimCommentsGateway } from '../claim-comments.gateway';
import { PrismaService } from '../../../common/services/prisma/prisma.service';

describe('ClaimCommentsGateway', () => {
  let gateway: ClaimCommentsGateway;
  let jwt: { verify: jest.Mock };
  let prisma: {
    user: { findUnique: jest.Mock };
    claim: { findUnique: jest.Mock };
  };

  const socket = (handshake: Record<string, unknown> = {}) =>
    ({ id: 'c-1', join: jest.fn(), handshake }) as any;
  const withCookie = () => socket({ headers: { cookie: 'a=1; sid=tok' } });

  beforeEach(async () => {
    jwt = { verify: jest.fn() };
    prisma = {
      user: { findUnique: jest.fn() },
      claim: { findUnique: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimCommentsGateway,
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'AUTH_COOKIE_NAME' ? 'sid' : 'secret',
          },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    gateway = module.get<ClaimCommentsGateway>(ClaimCommentsGateway);
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    };
  });

  it('handleConnection does not throw', () => {
    expect(() => gateway.handleConnection({ id: 'c-1' } as any)).not.toThrow();
  });

  it('handleDisconnect does not throw', () => {
    expect(() => gateway.handleDisconnect({ id: 'c-1' } as any)).not.toThrow();
  });

  it('lets an active admin join', async () => {
    jwt.verify.mockReturnValue({ sub: 'admin-1', type: 'admin' });
    prisma.user.findUnique.mockResolvedValue({ is_active: true });
    const client = withCookie();

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(jwt.verify).toHaveBeenCalledWith('tok', { secret: 'secret' });
    expect(client.join).toHaveBeenCalledWith('claim:claim-1');
  });

  it('refuses a deactivated admin', async () => {
    jwt.verify.mockReturnValue({ sub: 'admin-1', type: 'admin' });
    prisma.user.findUnique.mockResolvedValue({ is_active: false });
    const client = withCookie();

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(client.join).not.toHaveBeenCalled();
  });

  it('lets the profile the claim belongs to join', async () => {
    jwt.verify.mockReturnValue({ sub: 'profile-1', type: 'profile' });
    prisma.claim.findUnique.mockResolvedValue({ profile_id: 'profile-1' });
    const client = socket({ auth: { token: 'tok' } });

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(client.join).toHaveBeenCalledWith('claim:claim-1');
  });

  it("refuses a profile asking for somebody else's claim", async () => {
    jwt.verify.mockReturnValue({ sub: 'profile-2', type: 'profile' });
    prisma.claim.findUnique.mockResolvedValue({ profile_id: 'profile-1' });
    const client = withCookie();

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(client.join).not.toHaveBeenCalled();
  });

  // This was the whole gateway before: a claim id and nothing else.
  it('refuses a socket with no session', async () => {
    const client = socket({ headers: {} });

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(client.join).not.toHaveBeenCalled();
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('refuses an invalid or expired token', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('jwt expired');
    });
    const client = withCookie();

    await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

    expect(client.join).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'admin-phone'])(
    'refuses a %s token, which is not a session',
    async (type) => {
      jwt.verify.mockReturnValue({ sub: 'x', type });
      const client = withCookie();

      await gateway.handleJoinClaim(client, { claimId: 'claim-1' });

      expect(client.join).not.toHaveBeenCalled();
    },
  );

  it('refuses rather than throws when the lookup fails', async () => {
    jwt.verify.mockReturnValue({ sub: 'profile-1', type: 'profile' });
    prisma.claim.findUnique.mockRejectedValue(new Error('invalid uuid'));
    const client = withCookie();

    await expect(
      gateway.handleJoinClaim(client, { claimId: 'not-a-uuid' }),
    ).resolves.toBeUndefined();
    expect(client.join).not.toHaveBeenCalled();
  });

  it('handleJoinClaim does nothing without claimId', async () => {
    const client = withCookie();
    await gateway.handleJoinClaim(client, { claimId: '' });
    expect(client.join).not.toHaveBeenCalled();
  });

  it('handleJoinClaim does nothing when data is null', async () => {
    const client = withCookie();
    await gateway.handleJoinClaim(client, null as any);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('emitNewComment emits to the claim room', () => {
    const emitMock = jest.fn();
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    gateway.emitNewComment('claim-1', { text: 'hello' });
    expect((gateway as any).server.to).toHaveBeenCalledWith('claim:claim-1');
    expect(emitMock).toHaveBeenCalledWith('comment:new', { text: 'hello' });
  });

  it('emitDeletedComment emits to the claim room', () => {
    const emitMock = jest.fn();
    (gateway as any).server = {
      to: jest.fn().mockReturnValue({ emit: emitMock }),
    };
    gateway.emitDeletedComment('claim-1', 'cmt-42');
    expect(emitMock).toHaveBeenCalledWith('comment:deleted', {
      commentId: 'cmt-42',
    });
  });
});
