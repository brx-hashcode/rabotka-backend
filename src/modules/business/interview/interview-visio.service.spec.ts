import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { InterviewMode, InterviewStatus } from '@prisma/client';
import { InterviewVisioService, visioUrl } from './interview-visio.service';

const ROOM = 'Rabotka-abcDEF1234';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

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
    businessMember: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'Marie Recruteuse',
        email: 'm@example.com',
      }),
    },
  };
  const config = { get: (k: string) => env[k] };
  const subscriptions = { businessOf: jest.fn().mockResolvedValue('b1') };
  const service = new InterviewVisioService(
    prisma as never,
    config as never,
    subscriptions as never,
  );
  return { service, prisma, subscriptions };
}

const JAAS = {
  JAAS_APP_ID: 'vpaas-magic-cookie-123',
  JAAS_KEY_ID: 'vpaas-magic-cookie-123/key1',
  JAAS_PRIVATE_KEY: Buffer.from(PEM).toString('base64'),
};

describe('InterviewVisioService', () => {
  it('signs a host token for the business, scoped to its room', async () => {
    const { service, prisma } = setup(JAAS);
    const join = await service.asHost('p1', 'm1', ROOM);
    expect(prisma.interview.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          location: visioUrl(ROOM),
          business_id: 'b1',
        }),
      }),
    );
    if (join.provider !== 'jaas') throw new Error('expected jaas');
    expect(join.roomName).toBe(ROOM);
    expect(join.interviewId).toBe('i1');
    expect(decodeProtectedHeader(join.jwt)).toMatchObject({
      alg: 'RS256',
      kid: 'vpaas-magic-cookie-123/key1',
    });
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims).toMatchObject({
      aud: 'jitsi',
      iss: 'chat',
      sub: 'vpaas-magic-cookie-123',
      room: ROOM,
    });
    expect(claims.context.user).toMatchObject({
      name: 'Marie Recruteuse',
      moderator: 'true',
    });
  });

  it('gives the link holder a guest token under the candidate name', async () => {
    const { service } = setup({ ...JAAS, JAAS_KEY_ID: 'key1' });
    const join = await service.asGuest(ROOM);
    if (join.provider !== 'jaas') throw new Error('expected jaas');
    expect(decodeProtectedHeader(join.jwt).kid).toBe(
      'vpaas-magic-cookie-123/key1',
    );
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.context.user).toMatchObject({
      name: 'Awa Diop',
      moderator: 'false',
    });
    expect(join.host).toBe(false);
    expect(join).not.toHaveProperty('interviewId');
  });

  it('falls back to the public Jitsi room without JaaS keys', async () => {
    const { service } = setup({});
    await expect(service.asGuest(ROOM)).resolves.toMatchObject({
      provider: 'jitsi',
      url: `https://meet.jit.si/${ROOM}`,
    });
  });

  it('refuses a name that is not one of its rooms', async () => {
    const { service, prisma } = setup(JAAS);
    await expect(service.asGuest('../../x')).rejects.toThrow('introuvable');
    expect(prisma.interview.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a cancelled or finished interview', async () => {
    await expect(
      setup(
        JAAS,
        interview({ status: InterviewStatus.CANCELLED }),
      ).service.asGuest(ROOM),
    ).rejects.toThrow('annulé');
    await expect(
      setup(
        JAAS,
        interview({ starts_at: new Date(Date.now() - 5 * 60 * 60 * 1000) }),
      ).service.asHost('p1', undefined, ROOM),
    ).rejects.toThrow('terminé');
  });

  it('opens to guests only from the day before', async () => {
    const { service } = setup(
      JAAS,
      interview({ starts_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }),
    );
    await expect(service.asGuest(ROOM)).rejects.toThrow('veille');
  });

  it('is not found for another business', async () => {
    const { service } = setup(JAAS, null);
    await expect(service.asHost('p2', undefined, ROOM)).rejects.toThrow(
      'introuvable',
    );
  });
});
