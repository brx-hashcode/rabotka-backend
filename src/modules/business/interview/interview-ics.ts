/**
 * The calendar file sent with an interview e-mail (RFC 5545), so the date
 * lands in the candidate's agenda in one tap. METHOD:REQUEST to add or move
 * it (the same UID, a higher SEQUENCE), METHOD:CANCEL to take it out.
 */
export function interviewIcs(e: {
  uid: string;
  sequence: number;
  startsAt: Date;
  durationMinutes: number;
  summary: string;
  description: string;
  location: string | null;
  organizerName: string;
  cancelled?: boolean;
  now?: Date;
}): string {
  const end = new Date(e.startsAt.getTime() + e.durationMinutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rabotka//Entretiens//FR',
    'CALSCALE:GREGORIAN',
    `METHOD:${e.cancelled ? 'CANCEL' : 'REQUEST'}`,
    'BEGIN:VEVENT',
    `UID:${e.uid}@rabotka.work`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${stamp(e.now ?? new Date())}`,
    `DTSTART:${stamp(e.startsAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${text(e.summary)}`,
    `DESCRIPTION:${text(e.description)}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    `ORGANIZER;CN=${text(e.organizerName)}:mailto:no-reply@rabotka.work`,
    `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export type CalendarEvent = {
  uid: string;
  sequence: number;
  startsAt: Date;
  durationMinutes: number;
  summary: string;
  description: string;
  location: string | null;
  /** CONFIRMED, TENTATIVE (no answer yet) or CANCELLED. */
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
};

/**
 * A whole calendar to subscribe to (METHOD:PUBLISH): the business's
 * interviews, read again by the agenda every hour, so a new, moved or
 * cancelled interview shows there by itself.
 */
export function interviewsCalendar(
  name: string,
  events: CalendarEvent[],
  now = new Date(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Rabotka//Entretiens//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(name)}`,
    'X-WR-TIMEZONE:Africa/Brazzaville',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...events.flatMap((e) => {
      const end = new Date(e.startsAt.getTime() + e.durationMinutes * 60_000);
      return [
        'BEGIN:VEVENT',
        // Not the invitation's UID: the business may also have added the
        // candidate's invitation file, and the two must not overwrite.
        `UID:${e.uid}.agenda@rabotka.work`,
        `SEQUENCE:${e.sequence}`,
        `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(e.startsAt)}`,
        `DTEND:${stamp(end)}`,
        `SUMMARY:${text(e.summary)}`,
        `DESCRIPTION:${text(e.description)}`,
        ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
        `STATUS:${e.status}`,
        'END:VEVENT',
      ];
    }),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** UTC, the one form every calendar reads the same: 20261103T090000Z. */
function stamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Escaped as a TEXT value: backslash, semicolon, comma, newline. */
function text(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next, after a space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (parts.length ? 74 : 75), bytes.length);
    // Never cut a UTF-8 character in two.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}
