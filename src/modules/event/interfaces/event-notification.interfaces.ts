export interface EventNotificationRecipient {
  email: string;
  phone?: string;
  name: string;
}

export interface EventRecurrenceSummary {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  /** ISO 8601. Null when the series ends by count, or never. */
  until: string | null;
  count: number | null;
}

export interface EventNotificationPayload {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string;
  description?: string | null;
  location?: string | null;
  callToAction?: string | null;
  /** Set when the event is one occurrence of a series. */
  seriesId?: string | null;
  /**
   * The repeat rule, so the message can say "every Monday until December" and
   * the calendar attachment can carry an RRULE the recipient's own client
   * expands. One message describes the whole series — recipients are not mailed
   * per occurrence.
   */
  recurrence?: EventRecurrenceSummary | null;
}
