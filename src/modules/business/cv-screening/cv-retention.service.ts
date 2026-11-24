import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { answerFileId } from '../../job-offer/offer-questions';
import { businessDashboardUrl } from '../../mail/audience';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import {
  businessCvExpiringEmail,
  businessCvExpiringSubject,
} from '../../mail/templates/business-activity';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import { SystemConfigService } from '../../system-config/system-config.service';
import { addMonthsClamped } from '../subscription/subscription-rules';
import { businessEmailRecipients } from '../team/business-recipients';

/** How long before its CVs go a business is told. */
const NOTICE_DAYS = 30;

/** An offer still taking candidates: its CVs never expire. */
const RECRUITS = Prisma.sql`o.status IN ('ACTIVE', 'PARTIALLY_FILLED') AND o.deleted_at IS NULL`;

type Due = { title: string; until: Date; path: string };

/**
 * How long candidates' CVs are kept. Nothing expires while the offer recruits:
 * their date is moved on, every day. Once it stops, the date stays where it
 * is, `business.cv_limit_months` away, unless the business deletes them first;
 * reopening moves it on again. Closing deletes nothing, with one exception: a
 * careers-page candidate who took « Garder ma candidature » back goes then.
 *
 * Runs before each purge, which only reads the dates.
 */
@Injectable()
export class CvRetentionService {
  private readonly logger = new Logger(CvRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly events: EventEmitter2,
  ) {}

  /** Brings every date up to date. Throws rather than let a purge run on old ones. */
  async refresh(now = new Date()): Promise<void> {
    const months = await this.systemConfig.getCvLimitMonths();
    const until = addMonthsClamped(now, months);
    // Moved at most daily: an hourly sweep rewrites nothing.
    const stale = new Date(until.getTime() - 24 * 60 * 60 * 1000);

    // A CV with no date yet: from when it arrived.
    await this.prisma.$executeRaw`
      UPDATE external_applications
      SET cv_expires_at = created_at + make_interval(months => ${months}::int)
      WHERE cv_storage_key IS NOT NULL AND cv_expires_at IS NULL`;
    await this.prisma.$executeRaw`
      UPDATE answer_files
      SET expires_at = created_at + make_interval(months => ${months}::int)
      WHERE storage_key IS NOT NULL AND attached_at IS NOT NULL AND expires_at IS NULL`;

    await this.prisma.$executeRaw`
      UPDATE cv_screening_resumes r SET expires_at = ${until}
      FROM cv_screenings s JOIN job_offers o ON o.id = s.offer_id
      WHERE r.screening_id = s.id AND ${RECRUITS} AND r.removed_at IS NULL
        AND (r.expires_at IS NULL OR r.expires_at < ${stale})`;
    await this.prisma.$executeRaw`
      UPDATE cv_screenings s SET expires_at = ${until}
      FROM job_offers o
      WHERE o.id = s.offer_id AND ${RECRUITS} AND s.expires_at < ${stale}`;
    await this.prisma.$executeRaw`
      UPDATE external_applications a SET cv_expires_at = ${until}
      FROM job_offers o
      WHERE o.id = a.job_offer_id AND ${RECRUITS} AND a.cv_removed_at IS NULL
        AND a.cv_storage_key IS NOT NULL AND a.cv_expires_at < ${stale}`;
    await this.prisma.$executeRaw`
      UPDATE answer_files f SET expires_at = ${until}
      FROM job_offers o
      WHERE o.id = f.job_offer_id AND ${RECRUITS}
        AND f.storage_key IS NOT NULL AND f.attached_at IS NOT NULL
        AND f.removed_at IS NULL AND f.expires_at < ${stale}`;

    // Kept with the candidate's consent: at least that long.
    await this.prisma.$executeRaw`
      UPDATE external_applications SET cv_expires_at = pool_expires_at
      WHERE cv_storage_key IS NOT NULL AND cv_removed_at IS NULL
        AND pool_expires_at > cv_expires_at`;

    await this.endWithdrawn(now);

    await this.prisma.$executeRaw`
      UPDATE job_offers o SET cv_notice_at = NULL
      WHERE o.cv_notice_at IS NOT NULL AND ${RECRUITS}`;
  }

  /** They took their consent back, and the offer no longer recruits. */
  private async endWithdrawn(now: Date): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      { id: string; cv_resume_id: string | null; answers: unknown }[]
    >`
      SELECT a.id, a.cv_resume_id, a.answers
      FROM external_applications a
      JOIN job_offers o ON o.id = a.job_offer_id
      LEFT JOIN cv_screening_resumes r ON r.id = a.cv_resume_id
      WHERE a.pool_withdrawn_at IS NOT NULL AND NOT (${RECRUITS})
        AND (a.cv_expires_at > ${now} OR r.expires_at > ${now})
      LIMIT 300`;
    if (rows.length === 0) return;
    const files = rows.flatMap((r) =>
      Array.isArray(r.answers)
        ? (r.answers as Parameters<typeof answerFileId>[0][]).flatMap(
            (a) => answerFileId(a) ?? [],
          )
        : [],
    );
    await this.prisma.$transaction([
      this.prisma.externalApplication.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { cv_expires_at: now },
      }),
      this.prisma.cvScreeningResume.updateMany({
        where: { id: { in: rows.flatMap((r) => r.cv_resume_id ?? []) } },
        data: { expires_at: now },
      }),
      this.prisma.answerFile.updateMany({
        where: { id: { in: files } },
        data: { expires_at: now },
      }),
    ]);
  }

  /** Tells each business, once, of the CVs that go within a month. */
  async announce(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() + NOTICE_DAYS * 24 * 60 * 60 * 1000);
    const [offers, analyses] = await Promise.all([
      this.prisma.$queryRaw<
        { id: string; title: string; business_id: string; until: Date }[]
      >`
        SELECT o.id, o.title, b.id AS business_id, MIN(d.until) AS until
        FROM job_offers o
        JOIN businesses b ON b.profile_id = o.employer_id
        JOIN LATERAL (
          SELECT r.expires_at AS until FROM cv_screening_resumes r
            JOIN cv_screenings s ON s.id = r.screening_id
            LEFT JOIN external_applications x ON x.cv_resume_id = r.id
            WHERE s.offer_id = o.id AND r.removed_at IS NULL
              AND x.pool_withdrawn_at IS NULL
              AND (r.storage_key IS NOT NULL OR r.cv_text IS NOT NULL)
          UNION ALL
          SELECT a.cv_expires_at FROM external_applications a
            WHERE a.job_offer_id = o.id AND a.cv_storage_key IS NOT NULL
              AND a.cv_removed_at IS NULL AND a.pool_withdrawn_at IS NULL
        ) d ON d.until > ${now} AND d.until <= ${before}
        WHERE o.cv_notice_at IS NULL AND o.deleted_at IS NULL AND NOT (${RECRUITS})
        GROUP BY o.id, o.title, b.id
        LIMIT 200`,
      this.prisma.$queryRaw<
        { id: string; title: string; business_id: string; until: Date }[]
      >`
        SELECT s.id, s.job_title AS title, s.business_id, MIN(r.expires_at) AS until
        FROM cv_screenings s JOIN cv_screening_resumes r ON r.screening_id = s.id
        WHERE s.offer_id IS NULL AND s.cv_notice_at IS NULL AND r.removed_at IS NULL
          AND (r.storage_key IS NOT NULL OR r.cv_text IS NOT NULL)
          AND r.expires_at > ${now} AND r.expires_at <= ${before}
        GROUP BY s.id, s.job_title, s.business_id
        LIMIT 200`,
    ]);

    const byBusiness = new Map<string, Due[]>();
    const add = (businessId: string, due: Due) =>
      byBusiness.set(businessId, [...(byBusiness.get(businessId) ?? []), due]);
    // Claimed one by one: two sweeps at once never tell twice.
    for (const o of offers) {
      const { count } = await this.prisma.jobOffer.updateMany({
        where: { id: o.id, cv_notice_at: null },
        data: { cv_notice_at: now },
      });
      if (count > 0) {
        add(o.business_id, {
          title: o.title,
          until: o.until,
          path: `offres/${o.id}`,
        });
      }
    }
    for (const s of analyses) {
      const { count } = await this.prisma.cvScreening.updateMany({
        where: { id: s.id, cv_notice_at: null },
        data: { cv_notice_at: now },
      });
      if (count > 0) {
        add(s.business_id, {
          title: s.title,
          until: s.until,
          path: `analyse-cv/${s.id}`,
        });
      }
    }
    for (const [businessId, due] of byBusiness) {
      await this.tell(
        businessId,
        due.sort((a, b) => a.until.getTime() - b.until.getTime()),
      );
    }
    return byBusiness.size;
  }

  /** By e-mail and in the app, never WhatsApp: it is a business. */
  private async tell(businessId: string, due: Due[]): Promise<void> {
    try {
      const business = await this.prisma.business.findUnique({
        where: { id: businessId },
        select: { profile_id: true },
      });
      if (!business) return;
      notifyProfile(this.events, {
        recipientId: business.profile_id,
        input: {
          type: 'CV_EXPIRING',
          jobTitle: due[0].title,
          others: due.length - 1,
          until: due[0].until.toISOString(),
          path: due[0].path,
        },
      });
      const items = due.map((d) => ({
        title: d.title,
        until: d.until,
        url: `${businessDashboardUrl()}/${d.path}`,
      }));
      for (const r of await businessEmailRecipients(
        this.prisma,
        businessId,
        'recruiting',
      )) {
        const subject = businessCvExpiringSubject(r.language);
        await this.mail.sendMail({
          to: r.email,
          subject,
          html: await this.layout.wrap(
            businessCvExpiringEmail(r.name, items, r.language),
            {
              previewText: subject,
              product: 'business',
              language: r.language,
            },
          ),
        });
      }
    } catch (err) {
      this.logger.warn(
        `CV expiry notice for business ${businessId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
