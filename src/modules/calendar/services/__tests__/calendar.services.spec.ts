import { CalendarLinkService } from '../calendar-link.service';
import { IcsGeneratorService } from '../ics-generator.service';

describe('CalendarLinkService', () => {
  let service: CalendarLinkService;

  beforeEach(() => {
    service = new CalendarLinkService();
  });

  it('generates a Google Calendar link', () => {
    const link = service.googleCalendarLink({
      title: 'Test Event',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
    });
    expect(link).toContain('calendar.google.com');
    expect(link).toContain('Test+Event');
  });

  it('includes description and location when provided', () => {
    const link = service.googleCalendarLink({
      title: 'Meeting',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      description: 'Team meeting',
      location: 'Office',
    });
    expect(link).toContain('Team+meeting');
    expect(link).toContain('Office');
  });

  it('omits description and location when null', () => {
    const link = service.googleCalendarLink({
      title: 'Meeting',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      description: null,
      location: null,
    });
    expect(link).not.toContain('details');
    expect(link).not.toContain('location');
  });
});

describe('IcsGeneratorService', () => {
  let service: IcsGeneratorService;

  beforeEach(() => {
    service = new IcsGeneratorService();
  });

  it('generates a valid ICS string', () => {
    const ics = service.generate({
      title: 'Test Event',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Test Event');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('includes description when provided', () => {
    const ics = service.generate({
      title: 'Meeting',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      description: 'Team meeting',
    });
    expect(ics).toContain('DESCRIPTION:Team meeting');
  });

  it('includes location when provided', () => {
    const ics = service.generate({
      title: 'Meeting',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
      location: 'Office',
    });
    expect(ics).toContain('LOCATION:Office');
  });

  it('omits description when not provided', () => {
    const ics = service.generate({
      title: 'Event',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
    });
    expect(ics).not.toContain('DESCRIPTION');
  });

  it('escapes special characters in title', () => {
    const ics = service.generate({
      title: 'Event; with, special\\chars',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T10:00:00Z',
    });
    expect(ics).toContain('\\;');
  });

  describe('recurrence', () => {
    const base = {
      title: 'Standup',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T09:15:00Z',
    };

    it('emits no RRULE for a one-off event', () => {
      expect(service.generate(base)).not.toContain('RRULE');
    });

    it('encodes an end date as UNTIL, in the UTC form RFC 5545 requires', () => {
      const ics = service.generate({
        ...base,
        recurrence: { frequency: 'WEEKLY', until: '2026-12-31T23:59:59Z' },
      });
      expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261231T235959Z');
    });

    it('encodes an occurrence limit as COUNT', () => {
      const ics = service.generate({
        ...base,
        recurrence: { frequency: 'DAILY', count: 10 },
      });
      expect(ics).toContain('RRULE:FREQ=DAILY;COUNT=10');
    });

    it('emits a bare FREQ for an open-ended series', () => {
      // No UNTIL and no COUNT is RFC 5545 for "forever", which is exactly what
      // an open-ended series means.
      const ics = service.generate({
        ...base,
        recurrence: { frequency: 'MONTHLY' },
      });
      expect(ics).toContain('RRULE:FREQ=MONTHLY');
      expect(ics).not.toContain('UNTIL');
      expect(ics).not.toContain('COUNT');
    });

    it('places the RRULE inside the VEVENT, after DTEND', () => {
      const lines = service
        .generate({ ...base, recurrence: { frequency: 'WEEKLY' } })
        .split('\r\n');
      const dtEnd = lines.findIndex((l) => l.startsWith('DTEND:'));
      const rrule = lines.findIndex((l) => l.startsWith('RRULE:'));
      const endVevent = lines.indexOf('END:VEVENT');

      expect(rrule).toBeGreaterThan(dtEnd);
      expect(rrule).toBeLessThan(endVevent);
    });
  });

  describe('identity', () => {
    const base = {
      title: 'Standup',
      startDate: '2026-06-01T09:00:00Z',
      endDate: '2026-06-01T09:15:00Z',
    };

    it('uses the supplied uid verbatim, and the same one twice', () => {
      // The UID used to be `${Date.now()}@rabotka`, so the update mail carried
      // a different identity than the invitation and calendar clients filed it
      // as a second event instead of revising the first.
      const first = service.generate({ ...base, uid: 'event-42@rabotka' });
      const second = service.generate({ ...base, uid: 'event-42@rabotka' });

      expect(first).toContain('UID:event-42@rabotka');
      expect(second).toContain('UID:event-42@rabotka');
    });

    it('defaults SEQUENCE to 0 and emits what it is given', () => {
      expect(service.generate(base)).toContain('SEQUENCE:0');
      expect(service.generate({ ...base, sequence: 3 })).toContain(
        'SEQUENCE:3',
      );
    });
  });
});
