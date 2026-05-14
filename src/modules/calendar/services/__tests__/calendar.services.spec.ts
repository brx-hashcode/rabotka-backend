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
});
