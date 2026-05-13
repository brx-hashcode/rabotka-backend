export interface EventNotificationRecipient {
  email: string;
  phone?: string;
  name: string;
}

export interface EventNotificationPayload {
  eventId: string;
  title: string;
  startDate: string;
  endDate: string;
  description?: string | null;
  location?: string | null;
  callToAction?: string | null;
}
