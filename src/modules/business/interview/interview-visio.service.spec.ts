import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { InterviewMode, InterviewStatus } from '@prisma/client';
import { InterviewVisioService, visioUrl } from './interview-visio.service';

const ROOM = 'Rabotka-abcDEF1234';

function interview(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    business_id: 'b1',
    job_title: 'Assistant RH',
    candidate_name: 'Awa Diop',
    starts_at: new Date(Date.now() + 60 * 60 * 1000),
    duration_minutes: 30,
    mode: InterviewMode.VIDEO,
    location: visioUrl(ROOM),
    status: InterviewStatus.CONFIRMED,
    business: {
      name: 'The Yellow Team',
      profile: { email: 'owner@example.com', avatar_url: null },
    },
    ...over,
  };
}

function setup(
  env: Record<string, string | undefined>,
  row: ReturnType<typeof interview> | null = interview(),
) {
  const prisma = {
    interview: { findFirst: jest.fn().mockResolvedValue(row) },
    interviewGuest: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'g1',
        name: 'Marie Ngoma',
        email: 'marie@example.com',
      }),
    },
    businessMember: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'Marie Recruteuse',
        email: 'm@example.com',
      }),
    },
  };
  const config = { get: (k: string) => env[k] };
  const subscriptions = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({ videoInterviews: true }),
  };
  const service = new InterviewVisioService(
    prisma as never,
    config as never,
    subscriptions as never,
  );
  return { service, prisma, subscriptions };
}

const SECRET = 'a-long-random-secret-shared-with-the-jitsi-server';
const JITSI = {
  JITSI_DOMAIN: 'visio.hashcode.digital',
  JITSI_APP_ID: 'rabotka',
  JITSI_APP_SECRET: SECRET,
};
/** The secret alone: the domain and app id fall back to production's. */
const GUEST_ONLY_SECRET = { JITSI_APP_SECRET: SECRET };

describe('InterviewVisioService', () => {
  it('signs a host token for the business, scoped to its room', async () => {
    const { service, prisma } = setup(JITSI);
    const join = await service.asHost('p1', 'm1', ROOM);
    expect(prisma.interview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          location: visioUrl(ROOM),
          business_id: 'b1',
        }),
      }),
    );
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    expect(join.domain).toBe('visio.hashcode.digital');
    expect(join.roomName).toBe(ROOM);
    expect(join.interviewId).toBe('i1');
    expect(decodeProtectedHeader(join.jwt).alg).toBe('HS256');
    // The server's own check: the shared secret, its app id and audience.
    const { payload } = await jwtVerify(
      join.jwt,
      new TextEncoder().encode(SECRET),
      { issuer: 'rabotka', audience: 'jitsi' },
    );
    const claims = payload as Record<string, any>;
    expect(claims).toMatchObject({ sub: 'visio.hashcode.digital', room: ROOM });
    expect(claims.context.user).toMatchObject({
      name: 'Marie Recruteuse',
      moderator: true,
    });
  });

  it('names the account holder by their own row, not the company', async () => {
    const { service, prisma } = setup(JITSI);
    prisma.businessMember.findFirst.mockResolvedValue({
      name: 'Fariol Blondeau',
      email: 'owner@example.com',
    });
    const join = await service.asHost('p1', undefined, ROOM);
    expect(prisma.businessMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: 'b1', is_owner: true },
      }),
    );
    expect(join.displayName).toBe('Fariol Blondeau');
  });

  it('gives the link holder a guest token under the candidate name', async () => {
    const { service } = setup(GUEST_ONLY_SECRET);
    const join = await service.asGuest(ROOM);
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    expect(join.domain).toBe('visio.hashcode.digital');
    expect(decodeJwt(join.jwt).iss).toBe('rabotka');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.context.user).toMatchObject({
      name: 'Awa Diop',
      moderator: false,
    });
    expect(join.host).toBe(false);
    expect(join).not.toHaveProperty('interviewId');
  });

  it('lets an invited person in under their own name, never the candidate’s', async () => {
    const { service, prisma } = setup(JITSI);
    const join = await service.asGuest(ROOM, 'tok');
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.context.user).toMatchObject({
      id: 'invite-g1',
      name: 'Marie Ngoma',
      moderator: false,
    });
    expect(prisma.interviewGuest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ interview_id: 'i1' }),
      }),
    );
  });

  it('refuses a withdrawn invitation', async () => {
    const { service, prisma } = setup(JITSI);
    prisma.interviewGuest.findFirst.mockResolvedValue(null);
    await expect(service.asGuest(ROOM, 'old')).rejects.toThrow('plus valable');
  });

  it('falls back to the public Jitsi room without the Jitsi secret', async () => {
    const { service } = setup({});
    await expect(service.asGuest(ROOM)).resolves.toMatchObject({
      provider: 'jitsi',
      url: `https://meet.jit.si/${ROOM}`,
    });
  });

  it('refuses a name that is not one of its rooms', async () => {
    const { service, prisma } = setup(JITSI);
    await expect(service.asGuest('../../x')).rejects.toThrow('introuvable');
    expect(prisma.interview.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a cancelled or finished interview', async () => {
    await expect(
      setup(
        JITSI,
        interview({ status: InterviewStatus.CANCELLED }),
      ).service.asGuest(ROOM),
    ).rejects.toThrow('annulé');
    await expect(
      setup(
        JITSI,
        interview({ starts_at: new Date(Date.now() - 5 * 60 * 60 * 1000) }),
      ).service.asHost('p1', undefined, ROOM),
    ).rejects.toThrow('terminé');
  });

  it('once ended, closes to guests and tells the host', async () => {
    const ended = interview({ ended_at: new Date() });
    await expect(setup(JITSI, ended).service.asGuest(ROOM)).rejects.toThrow(
      'terminé',
    );
    const host = await setup(JITSI, ended).service.asHost('p1', 'm1', ROOM);
    expect(host.endedAt).toEqual(expect.any(String));
  });

  it('before the day before, says when it opens, with no token', async () => {
    const starts = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const { service } = setup(JITSI, interview({ starts_at: starts }));
    const join = await service.asGuest(ROOM);
    expect(join).toMatchObject({
      provider: 'waiting',
      jobTitle: 'Assistant RH',
      businessName: 'The Yellow Team',
      opensAt: new Date(starts.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(join).not.toHaveProperty('jwt');
  });

  it('still refuses a withdrawn invitation before it opens', async () => {
    const { service, prisma } = setup(
      JITSI,
      interview({ starts_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }),
    );
    prisma.interviewGuest.findFirst.mockResolvedValue(null);
    await expect(service.asGuest(ROOM, 'old')).rejects.toThrow('plus valable');
  });

  it('is not found for another business', async () => {
    const { service } = setup(JITSI, null);
    await expect(service.asHost('p2', undefined, ROOM)).rejects.toThrow(
      'introuvable',
    );
  });

  it('closes a booked room to everyone when the plan lacks the visio', async () => {
    const { service, subscriptions } = setup(JITSI);
    subscriptions.entitlements.mockResolvedValue({ videoInterviews: false });
    await expect(service.asHost('p1', undefined, ROOM)).rejects.toThrow(
      'formules supérieures',
    );
    await expect(service.asGuest(ROOM)).rejects.toThrow('pas disponible');
    await expect(service.asGuest(ROOM, 'tok')).rejects.toThrow(
      'pas disponible',
    );
  });
});
