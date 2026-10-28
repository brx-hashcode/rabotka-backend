import {
  InterviewCalendarService,
  toEvent,
} from '../interview-calendar.service';
import { interviewsCalendar } from '../interview-ics';

const interview = (over: Record<string, unknown> = {}) =>
  ({
    id: 'i1',
    business_id: 'b1',
    candidate_name: 'Awa Diallo',
    job_title: 'Hôtesse',
    starts_at: new Date('2026-11-03T09:00:00Z'),
    duration_minutes: 30,
    mode: 'VIDEO',
    location: 'https://meet.example/abc',
    message: null,
    status: 'PENDING',
    response_note: null,
    updated_at: new Date('2026-10-28T10:00:00Z'),
    ...over,
  }) as never;

function make(
  business: unknown = { id: 'b1', name: 'ZuaFood', calendar_token: null },
) {
  const prisma: any = {
    business: {
      findUnique: jest.fn().mockResolvedValue(business),
      update: jest.fn().mockResolvedValue({}),
    },
    interview: { findMany: jest.fn().mockResolvedValue([interview()]) },
  };
  const subscriptions: any = { businessOf: jest.fn().mockResolvedValue('b1') };
  return {
    service: new InterviewCalendarService(prisma, subscriptions),
    prisma,
  };
}

describe('InterviewCalendarService', () => {
  it('makes the link on first ask, then gives the same one', async () => {
    const { service, prisma } = make();
    const first = await service.link('p1');
    expect(first.url).toMatch(/\/api\/v1\/public\/calendar\/[\w-]{32}\.ics$/);
    expect(first.webcalUrl.startsWith('webcal:')).toBe(true);
    expect(prisma.business.update).toHaveBeenCalledTimes(1);

    prisma.business.findUnique.mockResolvedValue({ calendar_token: 'kept' });
    prisma.business.update.mockClear();
    expect((await service.link('p1')).url).toMatch(/\/kept\.ics$/);
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  it('replaces the link on reset', async () => {
    const { service, prisma } = make({ calendar_token: 'old' });
    const { url } = await service.reset('p1');
    expect(url).not.toContain('/old.ics');
    expect(prisma.business.update).toHaveBeenCalled();
  });

  it('serves the business’s recent and coming interviews, and 404s an unknown link', async () => {
    const { service, prisma } = make();
    const ics = await service.feed('tok');
    expect(prisma.business.findUnique).toHaveBeenCalledWith({
      where: { calendar_token: 'tok' },
      select: { id: true, name: true },
    });
    expect(ics).toContain('X-WR-CALNAME:Entretiens — ZuaFood');
    expect(ics).toContain('SUMMARY:Entretien — Awa Diallo (Hôtesse)');

    prisma.business.findUnique.mockResolvedValue(null);
    await expect(service.feed('nope')).rejects.toThrow('Agenda introuvable.');
    await expect(service.feed('')).rejects.toThrow('Agenda introuvable.');
  });

  it('marks each interview as the agenda understands it', () => {
    expect(toEvent(interview({ status: 'CONFIRMED' })).status).toBe(
      'CONFIRMED',
    );
    expect(toEvent(interview({ status: 'PENDING' })).status).toBe('TENTATIVE');
    expect(toEvent(interview({ status: 'RESCHEDULE_REQUESTED' })).status).toBe(
      'TENTATIVE',
    );
    expect(toEvent(interview({ status: 'DECLINED' })).status).toBe('CANCELLED');
    expect(toEvent(interview({ status: 'CANCELLED' })).status).toBe(
      'CANCELLED',
    );
    expect(
      toEvent(
        interview({
          status: 'RESCHEDULE_REQUESTED',
          response_note: 'Plutôt jeudi',
        }),
      ).description,
    ).toContain('« Plutôt jeudi »');
  });
});

describe('interviewsCalendar', () => {
  it('is a calendar to subscribe to, refreshed hourly, one event per interview', () => {
    const ics = interviewsCalendar(
      'Entretiens — ZuaFood',
      [toEvent(interview())],
      new Date('2026-10-28T10:00:00Z'),
    );
    expect(ics).toContain('METHOD:PUBLISH');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(ics).toContain('UID:i1.agenda@rabotka.work');
    expect(ics).toContain('DTSTART:20261103T090000Z');
    expect(ics).toContain('DTEND:20261103T093000Z');
    expect(ics).toContain('STATUS:TENTATIVE');
    expect(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(
      true,
    );
  });
});
