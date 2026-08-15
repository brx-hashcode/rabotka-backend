import { Injectable } from '@nestjs/common';

/** The repeat rule, in the shape the event module hands over. */
export type IcsRecurrence = {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** ISO 8601. Null when the series ends by count, or never. */
  until?: string | null;
  count?: number | null;
};

export type IcsEvent = {
  title: string;
  description?: string | null;
  startDate: string;
  endDate: string;
  location?: string | null;
  /**
   * Stable identity for this calendar entry. Pass the same value every time the
   * event is mailed — a client matches on UID, so a changing one turns an
   * update into a second entry in the recipient's calendar.
   */
  uid?: string;
  /**
   * Bumped on each update of the same UID. RFC 5545 §3.8.7.4 — a client ignores
   * a revision that is not newer than the one it already holds.
   */
  sequence?: number;
  /**
   * Set for a repeating event. The recipient's own calendar expands the rule,
   * which is why one message covers a whole series: DTSTART is the first
   * occurrence and RRULE describes the rest.
   */
  recurrence?: IcsRecurrence | null;
};

@Injectable()
export class IcsGeneratorService {
  generate(event: IcsEvent): string {
    // Falling back to a timestamp keeps old callers working, but it is not a
    // stable identity — anything that may later send an update should pass its
    // own uid.
    const uid = event.uid ?? `${Date.now()}@rabotka`;
    const now = this.formatDate(new Date());
    const dtStart = this.formatDate(new Date(event.startDate));
    const dtEnd = this.formatDate(new Date(event.endDate));

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Rabotka//Event//FR',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      event.recurrence ? this.rruleLine(event.recurrence) : '',
      `SEQUENCE:${event.sequence ?? 0}`,
      `SUMMARY:${this.escape(event.title)}`,
      event.description ? `DESCRIPTION:${this.escape(event.description)}` : '',
      event.location ? `LOCATION:${this.escape(event.location)}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');
  }

  /**
   * RFC 5545 §3.8.5.3.
   *
   * No INTERVAL part: the product offers plain presets, and a missing INTERVAL
   * already means 1. A rule with neither UNTIL nor COUNT repeats forever, which
   * is exactly how an open-ended series should read to the recipient.
   */
  private rruleLine(recurrence: IcsRecurrence): string {
    const parts = [`FREQ=${recurrence.frequency}`];

    if (recurrence.until) {
      // UNTIL must be UTC with a Z suffix when DTSTART is in UTC form, which
      // formatDate already produces.
      parts.push(`UNTIL=${this.formatDate(new Date(recurrence.until))}`);
    } else if (recurrence.count) {
      parts.push(`COUNT=${recurrence.count}`);
    }

    return `RRULE:${parts.join(';')}`;
  }

  private formatDate(date: Date): string {
    return date
      .toISOString()
      .replaceAll(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  }

  private escape(text: string): string {
    return text.replaceAll(/[\\;,\n]/g, (ch) => (ch === '\n' ? '' : `\\${ch}`));
  }
}
