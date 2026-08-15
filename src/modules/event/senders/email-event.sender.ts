import { Injectable } from '@nestjs/common';
import { NotificationService } from '../../notification/notification.service';
import type {
  EventNotificationRecipient,
  EventNotificationPayload,
} from '../interfaces/event-notification.interfaces';

@Injectable()
export class EmailEventSender {
  constructor(private readonly notification: NotificationService) {}

  async send(
    recipient: EventNotificationRecipient,
    payload: EventNotificationPayload,
    action: 'created' | 'updated',
  ): Promise<void> {
    const params = {
      to: recipient.email,
      name: recipient.name,
      title: payload.title,
      startDate: payload.startDate,
      endDate: payload.endDate,
      description: payload.description,
      location: payload.location,
      eventId: payload.eventId,
      seriesId: payload.seriesId,
      recurrence: payload.recurrence,
    };

    if (action === 'created') {
      await this.notification.notifyEventCreated(params);
    } else {
      await this.notification.notifyEventUpdated(params);
    }
  }
}
