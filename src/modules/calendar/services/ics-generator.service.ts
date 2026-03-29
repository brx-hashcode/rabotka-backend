import { Injectable } from '@nestjs/common';

@Injectable()
export class IcsGeneratorService {
  generate(event: {
    title: string;
    description?: string | null;
    startDate: string;
    endDate: string;
    location?: string | null;
  }): string {
    const uid = `${Date.now()}@rabotka`;
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
      `SUMMARY:${this.escape(event.title)}`,
      event.description ? `DESCRIPTION:${this.escape(event.description)}` : '',
      event.location ? `LOCATION:${this.escape(event.location)}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');
  }

  private formatDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  private escape(text: string): string {
    return text.replace(/[\\;,\n]/g, (ch) => (ch === '\n' ? '\\n' : `\\${ch}`));
  }
}
