import { Injectable } from '@nestjs/common';

@Injectable()
export class CalendarLinkService {
  googleCalendarLink(event: {
    title: string;
    startDate: string;
    endDate: string;
    description?: string | null;
    location?: string | null;
  }): string {
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: event.title,
      dates: `${this.formatDate(event.startDate)}/${this.formatDate(event.endDate)}`,
      ...(event.description && { details: event.description }),
      ...(event.location && { location: event.location }),
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  private formatDate(iso: string): string {
    return new Date(iso)
      .toISOString()
      .replaceAll('-', '')
      .replaceAll(':', '')
      .replaceAll('.', '');
  }
}
