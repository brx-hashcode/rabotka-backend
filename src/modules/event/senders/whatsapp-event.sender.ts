import { Injectable, Logger } from '@nestjs/common';
import type {
  EventNotificationRecipient,
  EventNotificationPayload,
} from '../interfaces/event-notification.interfaces';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { recurrenceLabel } from '../../../common/utils/recurrence-label.util';

@Injectable()
export class WhatsAppEventSender {
  private readonly logger = new Logger(WhatsAppEventSender.name);

  constructor(private readonly whatsAppService: WhatsAppService) {}

  async send(
    recipient: EventNotificationRecipient,
    payload: EventNotificationPayload,
    action: 'created' | 'updated',
  ): Promise<void> {
    if (!recipient.phone) return;

    const verb =
      action === 'created' ? 'Nouvel événement' : 'Événement mis à jour';
    let locationLine = '';
    if (payload.location) {
      locationLine = payload.callToAction
        ? `\n${payload.callToAction} : ${payload.location}`
        : `\nLien : ${payload.location}`;
    }
    // Same line the email carries: this message is sent once for a whole
    // series, so without it a weekly event looks like a single date.
    const repeats = recurrenceLabel(payload.recurrence);
    const repeatLine = repeats ? `\nRépétition : ${repeats}` : '';
    const message = `${verb} : ${payload.title}\nDu ${payload.startDate} au ${payload.endDate}${repeatLine}${locationLine}`;

    this.logger.log(
      `WhatsApp event notification to ${recipient.phone}: ${message.slice(0, 80)}`,
    );
    await this.whatsAppService.sendTextMessage(recipient.phone, message);
  }
}
