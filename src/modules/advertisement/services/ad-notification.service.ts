import { Injectable, Logger } from '@nestjs/common';
import { DeliveryChannel } from '@prisma/client';
import { NotificationService } from '../../notification/notification.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';

export type AdRecipient = {
  email: string;
  phone?: string;
  name: string;
};

export type AdNotificationPayload = {
  advertisementId: string;
  title: string;
  startDate: string;
  endDate: string;
  description?: string | null;
  ctaUrl?: string | null;
  callToAction?: string | null;
  imageUrl?: string | null;
};

@Injectable()
export class AdNotificationService {
  private readonly logger = new Logger(AdNotificationService.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  async dispatchCreated(
    recipient: AdRecipient,
    payload: AdNotificationPayload,
    channel: DeliveryChannel,
  ): Promise<void> {
    const sendEmail =
      channel === DeliveryChannel.EMAIL || channel === DeliveryChannel.ALL;
    const sendWhatsApp =
      channel === DeliveryChannel.WHATSAPP || channel === DeliveryChannel.ALL;

    const tasks: Promise<void>[] = [];

    if (sendEmail && recipient.email) {
      tasks.push(
        this.notificationService.notifyAdvertisementCreated({
          to: recipient.email,
          name: recipient.name,
          title: payload.title,
          startDate: payload.startDate,
          endDate: payload.endDate,
          description: payload.description,
          callToAction: payload.callToAction,
          ctaUrl: payload.ctaUrl,
          imageUrl: payload.imageUrl,
        }),
      );
    }

    if (sendWhatsApp && recipient.phone) {
      tasks.push(this.sendWhatsAppCreated(recipient.phone, payload));
    }

    await Promise.all(tasks);
  }

  private async sendWhatsAppCreated(
    phone: string,
    payload: AdNotificationPayload,
  ): Promise<void> {
    const message = this.buildWhatsAppMessage(payload);

    if (payload.imageUrl) {
      const sent = await this.whatsAppService.sendMediaMessage(
        phone,
        payload.imageUrl,
        message,
      );
      if (sent) return;
      this.logger.warn(
        `Failed to send ad media message to ${phone}, falling back to text`,
      );
    }

    await this.whatsAppService.sendTextMessage(phone, message);
  }

  private buildWhatsAppMessage(payload: AdNotificationPayload): string {
    const parts = [
      '*Nouvelle annonce Rabotka*',
      '',
      `*${payload.title}*`,
      `Du ${this.formatDate(payload.startDate)} au ${this.formatDate(payload.endDate)}`,
      payload.description ? `\n${payload.description}` : null,
      payload.ctaUrl
        ? `\nPour plus d'informations :\n${payload.callToAction?.trim() || 'En savoir plus'} -> ${payload.ctaUrl}`
        : null,
      '',
      "_L'equipe Rabotka_",
    ].filter((line): line is string => line !== null);

    return parts.join('\n');
  }

  private formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
