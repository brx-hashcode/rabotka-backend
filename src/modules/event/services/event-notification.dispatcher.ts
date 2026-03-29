import { Injectable, Logger } from '@nestjs/common';
import { DeliveryChannel } from '@prisma/client';
import { EmailEventSender } from '../senders/email-event.sender';
import { WhatsAppEventSender } from '../senders/whatsapp-event.sender';
import type {
  EventNotificationRecipient,
  EventNotificationPayload,
} from '../interfaces/event-notification.interfaces';

@Injectable()
export class EventNotificationDispatcher {
  private readonly logger = new Logger(EventNotificationDispatcher.name);

  constructor(
    private readonly emailSender: EmailEventSender,
    private readonly whatsAppSender: WhatsAppEventSender,
  ) {}

  async dispatchEventCreated(
    recipients: EventNotificationRecipient[],
    payload: EventNotificationPayload,
    channel: DeliveryChannel,
  ): Promise<void> {
    await this.dispatch(recipients, payload, channel, 'created');
  }

  async dispatchEventUpdated(
    recipients: EventNotificationRecipient[],
    payload: EventNotificationPayload,
    channel: DeliveryChannel,
  ): Promise<void> {
    await this.dispatch(recipients, payload, channel, 'updated');
  }

  private async dispatch(
    recipients: EventNotificationRecipient[],
    payload: EventNotificationPayload,
    channel: DeliveryChannel,
    action: 'created' | 'updated',
  ): Promise<void> {
    const sendEmail =
      channel === DeliveryChannel.EMAIL || channel === DeliveryChannel.ALL;
    const sendWhatsApp =
      channel === DeliveryChannel.WHATSAPP || channel === DeliveryChannel.ALL;

    const promises: Promise<void>[] = [];

    for (const recipient of recipients) {
      if (sendEmail && recipient.email) {
        promises.push(
          this.emailSender
            .send(recipient, payload, action)
            .catch((err) =>
              this.logger.error(
                `Email send failed for ${recipient.email}:`,
                err,
              ),
            ),
        );
      }
      if (sendWhatsApp && recipient.phone) {
        promises.push(
          this.whatsAppSender
            .send(recipient, payload, action)
            .catch((err) =>
              this.logger.error(
                `WhatsApp send failed for ${recipient.phone}:`,
                err,
              ),
            ),
        );
      }
    }

    await Promise.allSettled(promises);
  }
}
