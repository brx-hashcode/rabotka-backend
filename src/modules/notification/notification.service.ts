import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import {
  adminCreatedEmail,
  adminUpdatedEmail,
  sendOtpEmail,
  claimCreatedEmail,
  claimInProgressEmail,
  claimCompletedEmail,
  claimRejectedEmail,
  claimAssignedEmail,
  claimUnassignedEmail,
  eventCreatedEmail,
  eventUpdatedEmail,
  advertisementCreatedEmail,
  advertisementCompletedEmail,
} from '../mail/templates';
import {
  AdStats,
  AdTimelinePoint,
} from '../advertisement/services/ad-analytics.service';
import { CalendarLinkService } from '../calendar/services/calendar-link.service';
import { IcsGeneratorService } from '../calendar/services/ics-generator.service';
import { fetchWithTimeout } from '../../common/utils/fetch-with-timeout.util';

@Injectable()
export class NotificationService {
  constructor(
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly calendarLink: CalendarLinkService,
    private readonly icsGenerator: IcsGeneratorService,
  ) {}

  async notifyAdminCreated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Bienvenue sur Rabotka – Votre compte administrateur',
      html: await this.layout.wrap(adminCreatedEmail(name), {
        previewText: 'Votre compte administrateur Rabotka a été créé.',
      }),
    });
  }

  async notifyAdminUpdated(to: string, name: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Rabotka – Vos informations ont été mises à jour',
      html: await this.layout.wrap(adminUpdatedEmail(name), {
        previewText: 'Les informations de votre compte ont été mises à jour.',
      }),
    });
  }

  async notifyOtp(to: string, code: string): Promise<void> {
    await this.mail.sendMail({
      to,
      subject: 'Votre code de vérification Rabotka',
      html: await this.layout.wrap(sendOtpEmail(code), {
        previewText: `Votre code de vérification Rabotka : ${code}`,
      }),
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
      html: await this.layout.wrap(claimCreatedEmail(name, title)),
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
      html: await this.layout.wrap(claimInProgressEmail(name, title)),
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
      html: await this.layout.wrap(claimCompletedEmail(name, title)),
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
      html: await this.layout.wrap(claimRejectedEmail(name, title)),
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
      html: await this.layout.wrap(claimAssignedEmail(adminName, title)),
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
      html: await this.layout.wrap(claimUnassignedEmail(adminName, title)),
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
      html: await this.layout.wrap(
        eventCreatedEmail(
          name,
          title,
          startDate,
          endDate,
          description,
          location,
          googleCalendarUrl,
        ),
        { previewText: `Nouvel événement : ${title}` },
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
      html: await this.layout.wrap(
        eventUpdatedEmail(
          name,
          title,
          startDate,
          endDate,
          description,
          location,
          googleCalendarUrl,
        ),
        { previewText: `Mise à jour : ${title}` },
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
      html: await this.layout.wrap(advertisementCreatedEmail(params), {
        previewText: `Nouvelle annonce : ${params.title}`,
      }),
      ...(attachment ? { attachments: [attachment] } : {}),
    });
  }

  async notifyAdvertisementCompleted(params: {
    to: string;
    adTitle: string;
    startDate: string;
    endDate: string;
    stats: AdStats;
    timeline?: AdTimelinePoint[];
    excelBuffer: Buffer;
  }): Promise<void> {
    const slugTitle = params.adTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    await this.mail.sendMail({
      to: params.to,
      subject: `Rabotka – Rapport de campagne : ${params.adTitle}`,
      html: advertisementCompletedEmail({
        ...params,
        timeline: params.timeline,
      }),
      attachments: [
        {
          filename: `rapport-${slugTitle}.xlsx`,
          content: params.excelBuffer,
          contentType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    });
  }

  private async downloadImageAttachment(imageUrl?: string | null): Promise<{
    filename: string;
    content: Buffer;
    contentType?: string;
  } | null> {
    if (!imageUrl) return null;
    try {
      const res = await fetchWithTimeout(imageUrl, {}, 10_000);
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
