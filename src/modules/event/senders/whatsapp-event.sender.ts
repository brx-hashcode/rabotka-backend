import { Injectable, Logger } from '@nestjs/common';
import type {
  EventNotificationRecipient,
  EventNotificationPayload,
} from '../interfaces/event-notification.interfaces';
import { WhatsAppService } from 'src/modules/whatsapp/whatsapp.service';

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
    const message = `${verb} : ${payload.title}\nDu ${payload.startDate} au ${payload.endDate}${payload.location ? `\nLieu : ${payload.location}` : ''}`;

    this.logger.log(
      `WhatsApp event notification to ${recipient.phone}: ${message.slice(0, 80)}`,
    );
    await this.whatsAppService.sendTextMessage(recipient.phone, message);
  }
}
