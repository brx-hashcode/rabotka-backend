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
    if (action === 'created') {
      await this.notification.notifyEventCreated(
        recipient.email,
        recipient.name,
        payload.title,
        payload.startDate,
        payload.endDate,
        payload.description,
        payload.location,
      );
    } else {
      await this.notification.notifyEventUpdated(
        recipient.email,
        recipient.name,
        payload.title,
        payload.startDate,
        payload.endDate,
        payload.description,
        payload.location,
      );
    }
  }
}
