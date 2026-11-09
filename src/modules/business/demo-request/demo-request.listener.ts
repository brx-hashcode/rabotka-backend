import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../../common/events/admin-notification.events';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import { businessSiteUrl } from '../../mail/audience';
import {
  demoRequestReceivedEmail,
  demoRequestStaffEmail,
} from '../../mail/templates/demo-request';
import { BUSINESS_COUNTRY_NAMES } from '../business-catalog';
import {
  DEMO_INTEREST_LABELS,
  type DemoInterest,
} from './demo-request.constants';

/** Staff who get the e-mail: the ones who can run the business side. */
const STAFF_ROLES = [UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.MANAGER];

/**
 * After a demo request: the confirmation to the company, and an e-mail to
 * staff (the bell alert comes from the same event, in ws-notifications).
 * Never throws: the request is already saved.
 */
@Injectable()
export class DemoRequestListener {
  private readonly logger = new Logger(DemoRequestListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(AdminNotificationEvent.DEMO_REQUEST_CREATED, { async: true })
  async onCreated(payload: AdminNotificationPayload): Promise<void> {
    try {
      await this.send(payload.entityId);
    } catch (err) {
      this.logger.error(
        `Demo request e-mails failed for ${payload.entityId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async send(id: string): Promise<void> {
    const [demo, staff] = await Promise.all([
      this.prisma.demoRequest.findUnique({ where: { id } }),
      this.prisma.user.findMany({
        where: { role: { in: STAFF_ROLES }, is_active: true, deleted_at: null },
        select: { email: true, first_name: true },
      }),
    ]);
    if (!demo) return;

    const base = this.config
      .get<string>('ADMIN_BASE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    const country =
      BUSINESS_COUNTRY_NAMES[
        demo.country_code as keyof typeof BUSINESS_COUNTRY_NAMES
      ] ?? demo.country_code;
    const params = {
      name: `${demo.first_name} ${demo.last_name}`.trim(),
      jobTitle: demo.job_title,
      company: demo.company,
      country,
      companySize: demo.company_size,
      email: demo.email,
      phone: demo.phone,
      interests: demo.interests.map(
        (i) => DEMO_INTEREST_LABELS[i as DemoInterest] ?? i,
      ),
      message: demo.message,
      reviewUrl: `${base}/demo-requests/${demo.id}`,
    };

    const confirmation = this.mail.sendMail({
      to: demo.email,
      subject: 'Votre demande de démo Rabotka Business',
      html: await this.layout.wrap(
        demoRequestReceivedEmail({
          firstName: demo.first_name,
          company: demo.company,
          siteUrl: businessSiteUrl(),
        }),
        {
          previewText: 'Nous vous recontactons sous 24 h ouvrées.',
          product: 'business',
        },
      ),
    });
    const subject = `Rabotka – Demande de démo : ${demo.company}`;
    const toStaff = staff.map(async (s) =>
      this.mail.sendMail({
        to: s.email,
        subject,
        html: await this.layout.wrap(
          demoRequestStaffEmail({ ...params, staffFirstName: s.first_name }),
          { previewText: `${demo.company} demande une démo.` },
        ),
      }),
    );

    // One failed address must not cost the others their e-mail.
    const results = await Promise.allSettled([confirmation, ...toStaff]);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `Demo request e-mails: ${failed}/${results.length} not queued for ${id}`,
      );
    }
  }
}
