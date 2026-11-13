import { InterviewMode, InterviewStatus } from '@prisma/client';
import {
  InterviewTranscriptService,
  MAX_LINE_CHARS,
  MAX_LINES_PER_INTERVIEW,
  mergeTranscript,
} from './interview-transcript.service';
import { hashToken } from './interview.service';
import { visioUrl } from './interview-visio.service';

const ROOM = 'Rabotka-abcDEF1234';
const actor = { profileId: 'p1', memberId: 'm1' };

function interview(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    business_id: 'b1',
    candidate_name: 'Awa Diop',
    starts_at: new Date(Date.now() - 5 * 60 * 1000),
    duration_minutes: 30,
    mode: InterviewMode.VIDEO,
    location: visioUrl(ROOM),
    status: InterviewStatus.CONFIRMED,
    transcribe: true,
    transcript_consent: 'ACCEPTED',
    ended_at: null,
    business: { name: 'KAMOA' },
    ...over,
  };
}

function setup(row: Record<string, unknown> | null = interview(), count = 0) {
  const prisma = {
    interview: {
      findFirst: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(row),
    },
    interviewTranscriptLine: {
      count: jest.fn().mockResolvedValue(count),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    interviewGuest: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Marie Ngoma' }),
    },
    businessMember: {
      findFirst: jest.fn().mockResolvedValue({ name: 'Paul Recruteur' }),
    },
  };
  const subscriptions = {
    businessOf: jest.fn().mockResolvedValue('b1'),
    entitlements: jest.fn().mockResolvedValue({ videoInterviews: true }),
  };
  const service = new InterviewTranscriptService(
    prisma as never,
    subscriptions as never,
  );
  return { service, prisma, subscriptions };
}

const written = (prisma: ReturnType<typeof setup>['prisma']) =>
  prisma.interviewTranscriptLine.createMany.mock.calls[0][0].data as {
    speaker: string;
    role: string;
    text: string;
  }[];

describe('InterviewTranscriptService', () => {
  it('keeps the organiser’s sentences under their name', async () => {
    const { service, prisma } = setup();
    await service.addHostLines(actor, 'i1', [
      { text: '  Et vos   disponibilités ? ' },
      { text: '   ' },
    ]);
    expect(written(prisma)).toEqual([
      expect.objectContaining({
        speaker: 'Paul Recruteur',
        role: 'HOST',
        text: 'Et vos disponibilités ?',
      }),
    ]);
  });

  it('keeps the candidate’s sentences only once they accepted', async () => {
    const { service, prisma } = setup(interview({ transcript_consent: null }));
    await expect(
      service.addGuestLines(ROOM, [{ text: 'Bonjour' }]),
    ).rejects.toThrow('pas accepté');
    expect(prisma.interviewTranscriptLine.createMany).not.toHaveBeenCalled();

    const ok = setup();
    await ok.service.addGuestLines(ROOM, [{ text: 'Bonjour' }]);
    expect(written(ok.prisma)[0]).toMatchObject({
      speaker: 'Awa Diop',
      role: 'CANDIDATE',
    });
  });

  it('keeps an invited person’s sentences under their own name', async () => {
    const { service, prisma } = setup(interview({ transcript_consent: null }));
    await service.addGuestLines(ROOM, [{ text: 'Une question' }], 'tok');
    expect(prisma.interviewGuest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token_hash: hashToken('tok'), interview_id: 'i1' },
      }),
    );
    expect(written(prisma)[0]).toMatchObject({
      speaker: 'Marie Ngoma',
      role: 'GUEST',
    });
  });

  it('refuses when the transcription is off, or outside the interview', async () => {
    await expect(
      setup(interview({ transcribe: false })).service.addHostLines(
        actor,
        'i1',
        [{ text: 'x' }],
      ),
    ).rejects.toThrow('pas activée');
    await expect(
      setup(
        interview({ starts_at: new Date(Date.now() - 5 * 60 * 60 * 1000) }),
      ).service.addGuestLines(ROOM, [{ text: 'x' }]),
    ).rejects.toThrow('pendant l’entretien');
  });

  it('stops once the interview is ended', async () => {
    const { service } = setup(interview({ ended_at: new Date() }));
    await expect(
      service.addHostLines(actor, 'i1', [{ text: 'encore' }]),
    ).rejects.toThrow('terminé');
  });

  it('cuts long sentences and stops at the interview’s limit', async () => {
    const { service, prisma } = setup();
    await service.addHostLines(actor, 'i1', [{ text: 'a'.repeat(900) }]);
    expect(written(prisma)[0].text).toHaveLength(MAX_LINE_CHARS);

    const full = setup(interview(), MAX_LINES_PER_INTERVIEW);
    await expect(
      full.service.addHostLines(actor, 'i1', [{ text: 'encore' }]),
    ).resolves.toEqual({ added: 0 });
    expect(
      full.prisma.interviewTranscriptLine.createMany,
    ).not.toHaveBeenCalled();
  });

  it('switches on only with the plan’s « Visio dans Rabotka »; off always', async () => {
    const { service, prisma, subscriptions } = setup();
    subscriptions.entitlements.mockResolvedValue({ videoInterviews: false });
    await expect(service.setTranscribe(actor, 'i1', true)).rejects.toThrow(
      'formules supérieures',
    );
    await service.setTranscribe(actor, 'i1', false);
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { transcribe: false } }),
    );
  });

  it('switches on only in a Rabotka visio', async () => {
    const { service } = setup(
      interview({ location: 'https://meet.google.com/abc-defg-hij' }),
    );
    await expect(service.setTranscribe(actor, 'i1', true)).rejects.toThrow(
      'visio Rabotka',
    );
  });

  it('records the candidate’s answer, not an invited person’s', async () => {
    const { service, prisma } = setup();
    await service.answer(ROOM, false);
    expect(prisma.interview.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { transcript_consent: 'DECLINED' } }),
    );
    prisma.interview.update.mockClear();
    await service.answer(ROOM, true, 'tok');
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });
});

describe('mergeTranscript', () => {
  it('orders both sides by time and joins a speaker’s sentences into turns', () => {
    const at = (min: number, sec = 0) =>
      new Date(Date.UTC(2026, 10, 12, 9, min, sec));
    const out = mergeTranscript([
      { spoken_at: at(4), speaker: 'Paul', text: 'Et vos disponibilités ?' },
      { spoken_at: at(3), speaker: 'Awa', text: 'J’ai travaillé trois ans' },
      { spoken_at: at(3, 20), speaker: 'Awa', text: 'au Twiga.' },
    ]);
    expect(out.split('\n')).toEqual([
      '[10:03] Awa : J’ai travaillé trois ans au Twiga.',
      '[10:04] Paul : Et vos disponibilités ?',
    ]);
  });
});
