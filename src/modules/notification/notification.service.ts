import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import {
  adminCreatedEmail,
  adminUpdatedEmail,
  sendOtpEmail,
  sendWelcomeEmail,
  claimCreatedEmail,
  claimInProgressEmail,
  claimCompletedEmail,
  claimRejectedEmail,
  claimAssignedEmail,
  claimUnassignedEmail,
  eventCreatedEmail,
  eventUpdatedEmail,
  advertisementCreatedEmail,
} from '../mail/templates';
import { CalendarLinkService } from '../calendar/services/calendar-link.service';
import { IcsGeneratorService } from '../calendar/services/ics-generator.service';

@Injectable()
export class NotificationService {
  constructor(
    private readonly mail: MailService,
    private readonly calendarLink: CalendarLinkService,
    private readonly icsGenerator: IcsGeneratorService,
  ) {}

  async notifyAdminCreated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Bienvenue sur Rabotka – Votre compte administrateur',
      html: adminCreatedEmail(name),
    });
  }

  async notifyAdminUpdated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Vos informations ont été mises à jour',
      html: adminUpdatedEmail(name),
    });
  }

  async notifyWelcome(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Bienvenue sur Rabotka',
      html: sendWelcomeEmail(name),
    });
  }

  async notifyOtp(to: string, code: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Votre code de vérification Rabotka',
      html: sendOtpEmail(code),
    });
  }

  async notifyClaimCreated(
    to: string,
    name: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Votre réclamation a été créée',
      html: claimCreatedEmail(name, title),
    });
  }

  async notifyClaimInProgress(
    to: string,
    name: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Votre réclamation est en cours de traitement',
      html: claimInProgressEmail(name, title),
    });
  }

  async notifyClaimCompleted(
    to: string,
    name: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Votre réclamation a été résolue',
      html: claimCompletedEmail(name, title),
    });
  }

  async notifyClaimRejected(
    to: string,
    name: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Votre réclamation a été rejetée',
      html: claimRejectedEmail(name, title),
    });
  }

  async notifyClaimAssigned(
    to: string,
    adminName: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Une réclamation vous a été assignée',
      html: claimAssignedEmail(adminName, title),
    });
  }

  async notifyClaimUnassigned(
    to: string,
    adminName: string,
    title: string,
  ): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: "Rabotka – Vous avez été retiré d'une réclamation",
      html: claimUnassignedEmail(adminName, title),
    });
  }

  async notifyEventCreated(
    to: string,
    name: string,
    title: string,
    startDate: string,
    endDate: string,
    description?: string | null,
    location?: string | null,
  ): Promise<void> {
    const eventData = { title, startDate, endDate, description, location };
    const googleCalendarUrl = this.calendarLink.googleCalendarLink(eventData);
    const icsContent = this.icsGenerator.generate(eventData);

    await this.mail.sendMail({
      to,
      subject: `Rabotka – Nouvel événement : ${title}`,
      html: eventCreatedEmail(
        name,
        title,
        startDate,
        endDate,
        description,
        location,
        googleCalendarUrl,
      ),
      attachments: [
        {
          filename: 'event.ics',
          content: icsContent,
          contentType: 'text/calendar',
        },
      ],
    });
  }

  async notifyEventUpdated(
    to: string,
    name: string,
    title: string,
    startDate: string,
    endDate: string,
    description?: string | null,
    location?: string | null,
  ): Promise<void> {
    const eventData = { title, startDate, endDate, description, location };
    const googleCalendarUrl = this.calendarLink.googleCalendarLink(eventData);
    const icsContent = this.icsGenerator.generate(eventData);

    await this.mail.sendMail({
      to,
      subject: `Rabotka – Mise à jour de l'événement : ${title}`,
      html: eventUpdatedEmail(
        name,
        title,
        startDate,
        endDate,
        description,
        location,
        googleCalendarUrl,
      ),
      attachments: [
        {
          filename: 'event.ics',
          content: icsContent,
          contentType: 'text/calendar',
        },
      ],
    });
  }

  async notifyAdvertisementCreated(params: {
    to: string;
    name: string;
    title: string;
    startDate: string;
    endDate: string;
    description?: string | null;
    callToAction?: string | null;
    ctaUrl?: string | null;
    imageUrl?: string | null;
    tags?: string[] | null;
  }): Promise<void> {
    const attachment = await this.downloadImageAttachment(params.imageUrl);

    await this.mail.sendMail({
      to: params.to,
      subject: `Rabotka - Nouvelle annonce : ${params.title}`,
      html: advertisementCreatedEmail(params),
      ...(attachment ? { attachments: [attachment] } : {}),
    });
  }

  private async downloadImageAttachment(imageUrl?: string | null): Promise<{
    filename: string;
    content: Buffer;
    contentType?: string;
  } | null> {
    if (!imageUrl) return null;
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') ?? undefined;
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength === 0) return null;
      const buffer = Buffer.from(arrayBuffer);

      const ext = this.resolveImageExtension(imageUrl, contentType);
      const filename = `advertisement-image.${ext}`;

      return {
        filename,
        content: buffer,
        ...(contentType ? { contentType } : {}),
      };
    } catch {
      return null;
    }
  }

  private resolveImageExtension(url: string, contentType?: string): string {
    if (contentType?.includes('png')) return 'png';
    if (contentType?.includes('gif')) return 'gif';
    if (contentType?.includes('webp')) return 'webp';
    if (contentType?.includes('jpeg') || contentType?.includes('jpg'))
      return 'jpg';

    const withoutQuery = url.split('?')[0] ?? '';
    const candidate = withoutQuery.split('.').pop()?.toLowerCase();
    if (
      candidate &&
      ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(candidate)
    ) {
      return candidate === 'jpeg' ? 'jpg' : candidate;
    }
    return 'jpg';
  }
}
