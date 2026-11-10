import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../../common/events/admin-notification.events';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import { businessSiteUrl } from '../../mail/audience';
import {
  DEMO_REQUEST_RECEIVED_SUBJECT,
  demoRequestReceivedEmail,
} from '../../mail/templates/demo-request';
import { BUSINESS_COUNTRY_NAMES } from '../business-catalog';
import {
  DEMO_INTEREST_LABELS,
  type DemoInterest,
} from './demo-request.constants';

/**
 * After a demo request: one e-mail, the confirmation to the person who asked.
 * Staff are told by the admin bell, from the same event (ws-notifications),
 * never by e-mail. Never throws: the request is already saved.
 */
@Injectable()
export class DemoRequestListener {
  private readonly logger = new Logger(DemoRequestListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
  ) {}

  @OnEvent(AdminNotificationEvent.DEMO_REQUEST_CREATED, { async: true })
  async onCreated(payload: AdminNotificationPayload): Promise<void> {
    try {
      await this.confirm(payload.entityId);
    } catch (err) {
      this.logger.error(
        `Demo request confirmation failed for ${payload.entityId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async confirm(id: string): Promise<void> {
    const demo = await this.prisma.demoRequest.findUnique({ where: { id } });
    if (!demo) return;

    const country =
      BUSINESS_COUNTRY_NAMES[
        demo.country_code as keyof typeof BUSINESS_COUNTRY_NAMES
      ] ?? demo.country_code;

    await this.mail.sendMail({
      to: demo.email,
      subject: DEMO_REQUEST_RECEIVED_SUBJECT,
      html: await this.layout.wrap(
        demoRequestReceivedEmail({
          firstName: demo.first_name,
          company: demo.company,
          country,
          companySize: demo.company_size,
          phone: demo.phone,
          interests: demo.interests.map(
            (i) => DEMO_INTEREST_LABELS[i as DemoInterest] ?? i,
          ),
          siteUrl: businessSiteUrl(),
        }),
        {
          previewText: 'Nous vous appelons sous 24 h ouvrées.',
          product: 'business',
        },
      ),
    });
  }
}
