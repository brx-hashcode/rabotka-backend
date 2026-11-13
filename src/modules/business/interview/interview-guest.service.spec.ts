import { InterviewMode, InterviewStatus } from '@prisma/client';
import {
  InterviewGuestService,
  MAX_INTERVIEW_GUESTS,
} from './interview-guest.service';
import { hashToken } from './interview.service';
import { visioUrl } from './interview-visio.service';

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
    business: { name: 'KAMOA' },
    ...over,
  };
}

function setup(row: Record<string, unknown> | null = interview(), count = 0) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    interview: { findFirst: jest.fn().mockResolvedValue(row) },
    interviewGuest: {
      count: jest.fn().mockResolvedValue(count),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }) => {
        created.push(data);
        return Promise.resolve({ id: 'g1', created_at: new Date(), ...data });
      }),
      update: jest.fn(({ data }) =>
        Promise.resolve({
          id: 'g0',
          created_at: new Date(),
          email: 'marie@example.com',
          ...data,
        }),
      ),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    businessMember: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Paul Recruteur' }),
    },
  };
  const mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const layout = { wrap: jest.fn((html: string) => Promise.resolve(html)) };
  const subscriptions = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({ videoInterviews: true }),
  };
  const service = new InterviewGuestService(
    prisma as never,
    mail as never,
    layout as never,
    subscriptions as never,
  );
  return { service, prisma, mail, created, subscriptions };
}

describe('InterviewGuestService', () => {
  it('e-mails a personal link to the room, and keeps only its hash', async () => {
    const { service, mail, created } = setup();
    const guest = await service.invite('p1', 'm1', 'i1', {
      name: ' Marie Ngoma ',
      email: 'Marie@Example.com',
    });
    expect(guest).toMatchObject({
      name: 'Marie Ngoma',
      email: 'marie@example.com',
    });
    const html = mail.sendMail.mock.calls[0][0].html as string;
    const token = html.match(/\?g=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();
    expect(html).toContain(`${visioUrl(ROOM)}?g=`);
    expect(html).toContain('Paul Recruteur (KAMOA)');
    expect(created[0].token_hash).toBe(hashToken(token!));
    expect(JSON.stringify(created[0])).not.toContain(token!);
  });

  it('refuses an interview that is not a Rabotka visio', async () => {
    const { service } = setup(
      interview({ location: 'https://meet.google.com/abc-defg-hij' }),
    );
    await expect(
      service.invite('p1', undefined, 'i1', {
        name: 'Marie',
        email: 'marie@example.com',
      }),
    ).rejects.toThrow('visio Rabotka');
  });

  it(`stops at ${MAX_INTERVIEW_GUESTS} guests`, async () => {
    const { service } = setup(interview(), MAX_INTERVIEW_GUESTS);
    await expect(
      service.invite('p1', undefined, 'i1', {
        name: 'Marie',
        email: 'marie@example.com',
      }),
    ).rejects.toThrow('invités au plus');
  });

  it('invited again: a new link replaces the old one', async () => {
    const { service, prisma } = setup(interview(), MAX_INTERVIEW_GUESTS);
    prisma.interviewGuest.findUnique.mockResolvedValue({ id: 'g0' });
    await service.invite('p1', undefined, 'i1', {
      name: 'Marie',
      email: 'marie@example.com',
    });
    expect(prisma.interviewGuest.update).toHaveBeenCalled();
    expect(prisma.interviewGuest.create).not.toHaveBeenCalled();
  });

  it('refuses a cancelled or past interview', async () => {
    await expect(
      setup(interview({ status: InterviewStatus.CANCELLED })).service.invite(
        'p1',
        undefined,
        'i1',
        { name: 'Marie', email: 'marie@example.com' },
      ),
    ).rejects.toThrow('plus lieu');
    await expect(
      setup(
        interview({ starts_at: new Date(Date.now() - 3 * 60 * 60 * 1000) }),
      ).service.invite('p1', undefined, 'i1', {
        name: 'Marie',
        email: 'marie@example.com',
      }),
    ).rejects.toThrow('passé');
  });

  it('needs the plan’s « Visio dans Rabotka »', async () => {
    const { service, subscriptions, mail } = setup();
    subscriptions.entitlements.mockResolvedValue({ videoInterviews: false });
    await expect(
      service.invite('p1', undefined, 'i1', {
        name: 'Marie',
        email: 'marie@example.com',
      }),
    ).rejects.toThrow('formules supérieures');
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it('is not found for another business', async () => {
    const { service } = setup(null);
    await expect(service.list('p2', 'i1')).rejects.toThrow('introuvable');
  });
});
