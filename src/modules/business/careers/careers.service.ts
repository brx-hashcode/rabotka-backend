import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  MAX_ANALYSIS_ATTEMPTS,
  claimable,
  claimFresh,
} from '../applicant-score/analysis-attempts';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  CvScreeningResumeStatus,
  ExternalApplicationOrigin,
  ExternalApplicationStatus,
  JobOfferStatus,
  OfferQuestionKind,
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { kycBucket } from '../../../common/services/storage/kyc-bucket';
import { StorageService } from '../../../common/services/storage/storage.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import {
  enqueueCvAnalysis,
  queuedCvAnalyses,
} from '../applicant-score/cv-analysis-jobs';
import {
  answerText,
  type AnswerInput,
  candidateQuestion,
  answerFileId,
  checkAnswers,
  fileAnswerValue,
} from '../../job-offer/offer-questions';
import { businessSiteUrl, businessDashboardUrl } from '../../mail/audience';
import { LayoutService } from '../../mail/layout.service';
import type { MailLanguage } from '../../mail/templates/layout';
import { MailService } from '../../mail/mail.service';
import {
  applicationReceivedEmail,
  applicationRefusedEmail,
  applicationRetainCancelledEmail,
  applicationRetainedEmail,
  externalApplicationSubject,
  newExternalApplicationEmail,
  offerLanguage,
} from '../../mail/templates/external-application';
import {
  JOB_OFFER_CLOSED,
  type JobOfferClosedEvent,
} from '../../job-offer/job-offer.events';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import {
  CLOSED_OFFER_REFUSAL,
  refuseOutsideCandidates,
} from './refuse-closed-offer';
import { takenSeats } from '../../job-offer/utils/offer-seats';
import { feedSite, jobsFeedXml } from './job-feed';
import { SystemConfigService } from '../../system-config/system-config.service';
import { BUSINESS_CATEGORY_LABELS } from '../business-catalog';
import { writtenIn } from '../output-language';
import {
  CvScreeningService,
  type CvUpload,
} from '../cv-screening/cv-screening.service';
import { fillImportedContact } from './imported-contact';
import {
  BusinessSubscriptionService,
  cvBatchRoom,
} from '../subscription/business-subscription.service';
import {
  CV_EXTENSION,
  cvFileType,
  type CvFileType,
  DOCX_MIME,
  TEXT_MIME,
} from '../cv-screening/cv-files';
import type { ApplyDto } from './dto/apply.dto';
import { AnswerFilesService } from '../../answer-files/answer-files.service';
import { businessEmailRecipientsOfProfile } from '../team/business-recipients';
import { scoreView } from '../cv-screening/cv-marking';

const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

/** Where an imported CV came from: the business's computer, or its mailbox. */
export type ImportSource = 'import-device' | 'import-gmail';

/** « CV_Julien-Mbongolo_2026.pdf » → « CV Julien Mbongolo 2026 »: a name until the CV is read. */
export function placeholderName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const words = base
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (words || 'CV').slice(0, 80);
}

/** Stands in for a « Fichier » answer while the others are checked. */
const NO_FILE_YET = '00000000-0000-0000-0000-000000000000';

const MAX_COMPANIES = 200;
/** Careers applications listed at once for a business (the newest). */
const MAX_LISTED = 500;
/** Well above what Rabotka's businesses have open; a feed stays one file. */
const MAX_FEED_JOBS = 5000;

const COMPANY_SELECT = {
  id: true,
  profile_id: true,
  email: true,
  public_slug: true,
  name: true,
  category: true,
  city: true,
  website: true,
  description: true,
  distribute_offers: true,
  cover_url: true,
  photos: true,
  benefits: true,
  is_partner: true,
  partner_rank: true,
  profile: { select: { avatar_url: true } },
} as const;

/** Partners shown at once on the business site. */
const MAX_PARTNERS = 24;

const OFFER_SELECT = {
  reference: true,
  title: true,
  employment_type: true,
  scheduled_at: true,
  is_remote: true,
  city: true,
  country_code: true,
  country_name: true,
  quantity: true,
  created_at: true,
} as const;

/**
 * A business's public careers page, for candidates who are not on Rabotka:
 * who it is and what it has open. Nothing here needs a session, so everything
 * goes through an explicit select: never an address, a contact, or the
 * answers a question accepts. An unverified business has no page.
 */
@Injectable()
export class CareersService {
  private readonly logger = new Logger(CareersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly events: EventEmitter2,
    private readonly screenings: CvScreeningService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly queue: QueueService,
    private readonly answerFiles: AnswerFilesService,
  ) {}

  /** Where a business may be shown publicly: verified, with a careers page. */
  private liveBusiness() {
    return {
      public_slug: { not: null },
      deleted_at: null,
      verification_status: VerificationStatus.VERIFIED,
    };
  }

  /**
   * « Ils recrutent avec Rabotka »: the businesses staff picked, in their
   * order. A partner shows with or without open offers; never without a logo.
   */
  async partners() {
    const businesses = await this.prisma.business.findMany({
      where: {
        ...this.liveBusiness(),
        is_partner: true,
        profile: { avatar_url: { not: null } },
      },
      orderBy: [
        { partner_rank: { sort: 'asc', nulls: 'last' } },
        { name: 'asc' },
      ],
      take: MAX_PARTNERS,
      select: {
        public_slug: true,
        name: true,
        profile: { select: { avatar_url: true } },
      },
    });
    return businesses.map((b) => ({
      slug: b.public_slug as string,
      name: b.name,
      logoUrl: b.profile.avatar_url as string,
    }));
  }

  /**
   * Verified businesses that are hiring now: partners first, in staff's
   * order, then those with the most offers.
   */
  async companies() {
    const open = await this.prisma.jobOffer.groupBy({
      by: ['employer_id'],
      where: this.openNow(),
      _count: { _all: true },
    });
    const counts = new Map(open.map((o) => [o.employer_id, o._count._all]));
    const businesses = await this.prisma.business.findMany({
      where: {
        profile_id: { in: [...counts.keys()] },
        public_slug: { not: null },
        deleted_at: null,
        verification_status: VerificationStatus.VERIFIED,
      },
      select: COMPANY_SELECT,
    });
    const rank = (b: { is_partner: boolean; partner_rank: number | null }) =>
      b.is_partner
        ? (b.partner_rank ?? Number.MAX_SAFE_INTEGER - 1)
        : Number.MAX_SAFE_INTEGER;
    return businesses
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (counts.get(b.profile_id) ?? 0) - (counts.get(a.profile_id) ?? 0) ||
          a.name.localeCompare(b.name, 'fr'),
      )
      .map((b) => ({
        ...this.companyView(b),
        openOffers: counts.get(b.profile_id) ?? 0,
      }))
      .slice(0, MAX_COMPANIES);
  }

  /**
   * What search engines may list: verified businesses that kept distribution
   * on, and their open offers. Fed to the business app's sitemap.
   */
  async sitemap() {
    const businesses = await this.prisma.business.findMany({
      where: {
        public_slug: { not: null },
        deleted_at: null,
        verification_status: VerificationStatus.VERIFIED,
        distribute_offers: true,
      },
      select: { public_slug: true, profile_id: true, updated_at: true },
    });
    const bySlug = new Map(businesses.map((b) => [b.profile_id, b]));
    const offers = await this.prisma.jobOffer.findMany({
      where: { ...this.openNow(), employer_id: { in: [...bySlug.keys()] } },
      select: { reference: true, employer_id: true, updated_at: true },
    });
    const withOffers = new Set(offers.map((o) => o.employer_id));
    return {
      companies: businesses
        .filter((b) => withOffers.has(b.profile_id))
        .map((b) => ({
          slug: b.public_slug as string,
          updatedAt: b.updated_at.toISOString(),
        })),
      offers: offers.map((o) => ({
        slug: bySlug.get(o.employer_id)!.public_slug as string,
        reference: o.reference,
        updatedAt: o.updated_at.toISOString(),
      })),
    };
  }

  /** Every offer search engines may list, as the aggregators' XML feed. */
  async feed(site: string) {
    const offers = await this.prisma.jobOffer.findMany({
      where: {
        ...this.openNow(),
        employer: {
          business: {
            public_slug: { not: null },
            deleted_at: null,
            verification_status: VerificationStatus.VERIFIED,
            distribute_offers: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: MAX_FEED_JOBS,
      select: {
        ...OFFER_SELECT,
        description: true,
        amount: true,
        payment_flow: true,
        employer: {
          select: { business: { select: { public_slug: true, name: true } } },
        },
      },
    });
    return jobsFeedXml(
      offers.map((o) => ({
        slug: o.employer.business!.public_slug as string,
        company: o.employer.business!.name,
        reference: o.reference,
        title: o.title,
        description: o.description,
        employmentType: o.employment_type,
        createdAt: o.created_at,
        closesAt: o.scheduled_at,
        city: o.city,
        countryName: o.country_name,
        isRemote: o.is_remote,
        amount: o.amount === null ? null : Number(o.amount),
        paymentFlow: o.payment_flow,
      })),
      { site: feedSite(site), baseUrl: businessSiteUrl(), now: new Date() },
    );
  }

  async company(slug: string) {
    const business = await this.business(slug);
    const offers = await this.prisma.jobOffer.findMany({
      where: this.openOffers(business.profile_id),
      orderBy: { created_at: 'desc' },
      select: OFFER_SELECT,
    });
    return {
      company: this.companyView(business),
      offers: offers.map((o) => this.offerView(o)),
    };
  }

  async offer(slug: string, reference: string) {
    const business = await this.business(slug);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { ...this.openOffers(business.profile_id), reference },
      select: {
        ...OFFER_SELECT,
        description: true,
        amount: true,
        payment_flow: true,
        category: { select: { name: true } },
        questions: { orderBy: { position: 'asc' } },
      },
    });
    if (!offer) throw new NotFoundException('Cette offre est fermée.');
    return {
      company: this.companyView(business),
      offer: {
        ...this.offerView(offer),
        description: offer.description,
        amount: offer.amount === null ? null : Number(offer.amount),
        paymentFlow: offer.payment_flow,
        categoryName: offer.category?.name ?? null,
        questions: offer.questions.map(candidateQuestion),
        /**
         * The offer's own language, read from its text: its page and its
         * application form speak it, whatever the visitor's browser says. The
         * text first, longer than a title like « Delivery driver ».
         */
        language: writtenIn(offer.description, offer.title),
      },
    };
  }

  /** An application from someone with no account: a CV and their answers. */
  async apply(
    slug: string,
    reference: string,
    file: Express.Multer.File | undefined,
    dto: ApplyDto,
    /** « Fichier » answers: the answer's value is `file:<index>` in this list. */
    answerFiles: Express.Multer.File[] = [],
  ) {
    // The field only a bot fills: it is told it worked, and nothing is kept.
    if (dto.website) return { sent: true };

    const business = await this.business(slug);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { ...this.openOffers(business.profile_id), reference },
      select: {
        id: true,
        title: true,
        description: true,
        questions: { orderBy: { position: 'asc' } },
      },
    });
    if (!offer) throw new NotFoundException('Cette offre est fermée.');
    if (!file) throw new BadRequestException('Ajoutez votre CV.');
    const type = cvFileType(file.buffer, file.mimetype);
    if (type !== 'application/pdf' && type !== DOCX_MIME) {
      throw new BadRequestException(
        'Le CV doit être un PDF ou un fichier Word.',
      );
    }

    const email = dto.email.trim().toLowerCase();
    const seen = await this.prisma.externalApplication.findUnique({
      where: { job_offer_id_email: { job_offer_id: offer.id, email } },
      select: {
        id: true,
        status: true,
        refusal_message: true,
        cv_storage_key: true,
        cv_storage_bucket: true,
      },
    });
    if (seen) {
      // Nobody turned them down: the offer closed, and it is open again.
      if (
        seen.status !== ExternalApplicationStatus.REFUSED ||
        seen.refusal_message !== CLOSED_OFFER_REFUSAL
      ) {
        throw this.alreadyApplied();
      }
      await this.prisma.externalApplication.delete({ where: { id: seen.id } });
      if (seen.cv_storage_key) {
        void this.storage
          .delete(seen.cv_storage_key, {
            bucket: seen.cv_storage_bucket ?? undefined,
          })
          .catch((err) =>
            this.logger.warn(`Old CV not deleted: ${String(err)}`),
          );
      }
    }

    // A « Fichier » answer names its file by index: checked like the others
    // with a stand-in, the file stored only once every answer is valid.
    const fileIndex = new Map<string, number>();
    const answers = this.parseAnswers(dto.answers).map((a) => {
      const m = /^file:(\d)$/.exec(String(a?.value ?? ''));
      const q = offer.questions.find((x) => x.id === a?.questionId);
      if (!m || q?.kind !== OfferQuestionKind.FILE) return a;
      fileIndex.set(q.id, Number(m[1]));
      return { ...a, value: fileAnswerValue(NO_FILE_YET, `#${m[1]}`) };
    });
    const { rows, knockedOut } = checkAnswers(offer.questions, answers);
    for (const row of rows) {
      const i = fileIndex.get(row.question_id);
      if (i === undefined) continue;
      const stored = await this.answerFiles.upload(offer.id, answerFiles[i], {
        attached: true,
      });
      row.value = stored.value;
    }

    const id = randomUUID();
    const bucket = await kycBucket(this.systemConfig, this.config);
    const { key } = await this.storage.upload(
      file.buffer,
      `${randomUUID()}.${CV_EXTENSION[type]}`,
      {
        folder: `external-applications/${business.id}/${id}`,
        mimeType: type,
        access: 'private',
        bucket,
      },
    );

    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    // « Garder ma candidature »: for a set time, with a link to take it back.
    const pool =
      dto.poolConsent === 'true' ? await this.poolTerms(new Date()) : null;
    try {
      await this.prisma.externalApplication.create({
        data: {
          id,
          job_offer_id: offer.id,
          first_name: firstName,
          last_name: lastName,
          email,
          phone: dto.phone.trim(),
          answers: rows.map((r) => ({
            label: r.label,
            kind: r.kind,
            value: r.value,
            passed: r.passed,
          })),
          knocked_out: knockedOut,
          source: dto.source ?? null,
          consented_at: new Date(),
          ...(pool
            ? {
                pool_consent_at: new Date(),
                pool_expires_at: pool.expiresAt,
                pool_token_hash: pool.tokenHash,
              }
            : {}),
          cv_file_name: file.originalname.slice(0, 200),
          cv_mime_type: type,
          cv_size_bytes: file.size,
          cv_storage_key: key,
          cv_storage_bucket: bucket,
        },
      });
    } catch (err) {
      await this.storage.delete(key, { bucket }).catch(() => undefined);
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw this.alreadyApplied();
      }
      throw err;
    }

    const name = `${firstName} ${lastName}`;
    notifyProfile(this.events, {
      recipientId: business.profile_id,
      actorId: business.profile_id,
      input: {
        type: 'NEW_APPLICATION',
        applicationId: id,
        jobOfferId: offer.id,
        jobTitle: offer.title,
        workerName: name,
      },
    });
    const language = offerLanguage(offer);
    void this.send(
      email,
      externalApplicationSubject.received(business.name, language),
      applicationReceivedEmail(
        firstName,
        business.name,
        offer.title,
        pool
          ? { until: pool.expiresAt, withdrawUrl: this.withdrawUrl(pool.token) }
          : null,
        language,
      ),
      language,
    );
    // To the team, as its other recruiting e-mails: the holder and every
    // member who left them on (not the organisation's contact address).
    void businessEmailRecipientsOfProfile(
      this.prisma,
      business.profile_id,
      'recruiting',
    )
      .then(async (recipients) => {
        for (const r of recipients) {
          await this.send(
            r.email,
            // To a member of the team: in the language they read the app in.
            r.language === 'en'
              ? `New application: ${offer.title}`
              : `Nouvelle candidature : ${offer.title}`,
            newExternalApplicationEmail(
              name,
              offer.title,
              // The offer, where its candidates are, rather than every candidature.
              `${businessDashboardUrl()}/offres/${offer.id}`,
              r.language,
            ),
            r.language,
          );
        }
      })
      .catch((err) =>
        this.logger.warn(`Careers mail recipients failed: ${String(err)}`),
      );
    // Scored at once, on the plan's « CV inclus ». The candidate is not kept
    // waiting, and a plan with none left simply shows the CV unscored.
    void enqueueCvAnalysis(this.queue, {
      kind: 'careers',
      applicationId: id,
      offerId: offer.id,
      employerId: business.profile_id,
    }).catch((err) =>
      this.logger.warn(`CV analysis of ${id} not queued: ${String(err)}`),
    );
    return { sent: true };
  }

  /**
   * CVs the business has itself (on its computer, or ticked in its mailbox)
   * become candidates of one of its open offers: read and ranked with those
   * who applied, decided the same way. Each uses one of the plan's « CV
   * inclus », so a batch above what is left is refused whole rather than
   * half imported and half never read. Nobody is told: they did not apply.
   * Name and contact come from the analysis (fillImportedContact).
   */
  async importCvs(
    profileId: string,
    offerId: string,
    files: (CvUpload & { source: ImportSource })[],
  ) {
    const offer = await this.prisma.jobOffer.findFirst({
      where: {
        id: offerId,
        employer_id: profileId,
        deleted_at: null,
        status: { in: OPEN },
      },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Cette offre ne recrute plus.');
    if (files.length === 0) {
      throw new BadRequestException('Ajoutez au moins un CV.');
    }
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) throw new NotFoundException('Organisation introuvable.');
    const e = await this.subscriptions.entitlements(businessId);
    const room = cvBatchRoom(e);
    if (room === 0 || e.trialLocked.includes('cvAnalysis')) {
      throw new ForbiddenException(
        'Vous avez utilisé tous les CV inclus dans votre formule pour cette période. Changez de formule pour en analyser davantage.',
      );
    }
    if (files.length > room) {
      throw new BadRequestException(
        `Votre formule permet encore ${room} CV : retirez-en ${files.length - room}.`,
      );
    }
    const maxBytes = e.cvFileMaxMb * 1024 * 1024;
    const typed = files.map((file) => {
      const name = file.originalname || 'cv';
      if (file.size > maxBytes) {
        throw new BadRequestException(
          `« ${name} » dépasse ${e.cvFileMaxMb} Mo.`,
        );
      }
      // Sniffed: a text CV is only ever Rabotka's own, never an upload.
      const type = cvFileType(file.buffer, file.mimetype);
      if (!type || type === TEXT_MIME) {
        throw new BadRequestException(
          `« ${name} » n'est pas reconnu : envoyez un PDF, un fichier Word (.docx) ou une photo (JPG, PNG, WEBP).`,
        );
      }
      return { file, type, name };
    });

    const bucket = await kycBucket(this.systemConfig, this.config);
    const ids: string[] = [];
    for (const { file, type, name } of typed) {
      const id = randomUUID();
      const { key } = await this.storage.upload(
        file.buffer,
        `${randomUUID()}.${CV_EXTENSION[type]}`,
        {
          folder: `external-applications/${businessId}/${id}`,
          mimeType: type,
          access: 'private',
          bucket,
        },
      );
      try {
        await this.prisma.externalApplication.create({
          data: {
            id,
            job_offer_id: offer.id,
            origin: ExternalApplicationOrigin.IMPORT,
            // Until the analysis reads the name: the file's, as the business knows it.
            first_name: placeholderName(name),
            last_name: '',
            source: file.source,
            cv_file_name: name.slice(0, 200),
            cv_mime_type: type,
            cv_size_bytes: file.size,
            cv_storage_key: key,
            cv_storage_bucket: bucket,
          },
        });
      } catch (err) {
        await this.storage.delete(key, { bucket }).catch(() => undefined);
        throw err;
      }
      ids.push(id);
    }
    // Read like a careers CV, one job each: charged as it is read.
    for (const id of ids) {
      await enqueueCvAnalysis(this.queue, {
        kind: 'careers',
        applicationId: id,
        offerId: offer.id,
        employerId: profileId,
      }).catch((err) =>
        this.logger.warn(`CV analysis of ${id} not queued: ${String(err)}`),
      );
    }
    return { imported: ids.length };
  }

  /**
   * Takes imported CVs off an offer: the candidate, its analysis and both
   * files go. Only imports: someone who applied stays, to be refused. A
   * retained one is kept (its post is taken): « Ne plus retenir » first.
   * Their notes and opinions go with them; an interview keeps its record.
   */
  async deleteImported(profileId: string, ids: string[]) {
    const rows = await this.prisma.externalApplication.findMany({
      where: {
        id: { in: ids },
        origin: ExternalApplicationOrigin.IMPORT,
        status: { not: ExternalApplicationStatus.RETAINED },
        job_offer: { employer_id: profileId },
      },
      select: {
        id: true,
        cv_storage_key: true,
        cv_storage_bucket: true,
        cv_resume: {
          select: { id: true, storage_key: true, storage_bucket: true },
        },
      },
    });
    if (rows.length === 0) return { deleted: 0, kept: ids.length };
    const resumes = rows.flatMap((r) => (r.cv_resume ? [r.cv_resume] : []));
    await this.prisma.$transaction([
      this.prisma.externalApplication.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      }),
      this.prisma.cvScreeningResume.deleteMany({
        where: { id: { in: resumes.map((r) => r.id) } },
      }),
    ]);
    // The files after the rows: a file left behind is only storage, a row
    // left without its file would be a CV that cannot open.
    const objects = [
      ...rows.map((r) => [r.cv_storage_key, r.cv_storage_bucket] as const),
      ...resumes.map((r) => [r.storage_key, r.storage_bucket] as const),
    ];
    for (const [key, bucket] of objects) {
      if (!key) continue;
      await this.storage
        .delete(key, { bucket: bucket ?? undefined })
        .catch((err) =>
          this.logger.warn(`Imported CV file not deleted: ${String(err)}`),
        );
    }
    return { deleted: rows.length, kept: ids.length - rows.length };
  }

  /** The business's own: newest first, a failed « éliminatoire » after the others. */
  /**
   * The careers-page applications of the business, or of one offer: the
   * offer page asks for its own, rather than every application ever and a
   * filter in the browser, polled every few seconds while a CV is read.
   * The newest MAX_LISTED.
   */
  async listForBusiness(profileId: string, offerId?: string) {
    const rows = await this.prisma.externalApplication.findMany({
      where: {
        job_offer: { employer_id: profileId, deleted_at: null },
        ...(offerId ? { job_offer_id: offerId } : {}),
      },
      orderBy: [{ knocked_out: 'asc' }, { created_at: 'desc' }],
      take: MAX_LISTED,
      include: {
        job_offer: { select: { id: true, title: true, status: true } },
        cv_resume: {
          select: {
            id: true,
            status: true,
            score: true,
            summary: true,
            strengths: true,
            gaps: true,
            criteria: true,
            reading: true,
            grid: { select: { id: true, version: true, items: true } },
            screening_id: true,
          },
        },
      },
    });
    // A CV not linked to its analysis yet may already be on its way: queued
    // at import or on applying, or being read now (claimed).
    const unread = rows.filter(
      (a) => !a.cv_resume && a.cv_storage_key && !a.cv_removed_at,
    );
    const queued = await queuedCvAnalyses(
      this.queue,
      'careers',
      unread.map((a) => a.id),
    );
    const now = new Date();
    return rows.map((a) => ({
      id: a.id,
      firstName: a.first_name,
      lastName: a.last_name,
      email: a.email,
      phone: a.phone,
      status: a.status,
      // As the business reads them: « Oui », a date in words.
      answers: (Array.isArray(a.answers)
        ? (a.answers as { kind: OfferQuestionKind; value: string }[])
        : []
      ).map((x) => ({
        ...x,
        value: answerText(x),
        // « Fichier »: business/me/answer-files/:fileId opens it.
        fileId: answerFileId(x),
      })),
      knockedOut: a.knocked_out,
      source: a.source,
      origin: a.origin,
      hasCv: a.cv_storage_key !== null && !a.cv_removed_at,
      /** « Supprimer le CV »: by the business, the score stays. */
      cvRemoved: !!a.cv_removed_at,
      cvFileName: a.cv_file_name,
      cvMimeType: a.cv_mime_type,
      createdAt: a.created_at.toISOString(),
      viewedAt: a.viewed_at?.toISOString() ?? null,
      shortlistedAt: a.shortlisted_at?.toISOString() ?? null,
      offer: a.job_offer,
      // Being read, though no analysis shows yet: nothing to press, it comes.
      analysisQueued:
        !a.cv_resume &&
        !!a.cv_storage_key &&
        !a.cv_removed_at &&
        (queued.has(a.id) || claimFresh(a.analysis_claimed_at, now)),
      analysis: a.cv_resume && {
        resumeId: a.cv_resume.id,
        screeningId: a.cv_resume.screening_id,
        status: a.cv_resume.status,
        score: a.cv_resume.score,
        summary: a.cv_resume.summary,
        strengths: a.cv_resume.strengths,
        gaps: a.cv_resume.gaps,
        criteria: a.cv_resume.criteria,
        /** Marked on the offer's grid; null on the previous formula. */
        scoring: scoreView(a.cv_resume),
      },
    }));
  }

  /**
   * « Analyser » pressed by the business. One CV already on its way (queued,
   * or being read) is said to be so, rather than « Aucun CV à analyser ».
   */
  async analyseRequested(
    profileId: string,
    offerId: string,
    applicationId?: string,
    retryFailedBefore?: Date,
  ) {
    if (applicationId) {
      const row = await this.prisma.externalApplication.findFirst({
        where: {
          id: applicationId,
          job_offer: { id: offerId, employer_id: profileId },
        },
        select: { id: true, cv_resume_id: true, analysis_claimed_at: true },
      });
      if (
        row &&
        !row.cv_resume_id &&
        (claimFresh(row.analysis_claimed_at, new Date()) ||
          (await queuedCvAnalyses(this.queue, 'careers', [row.id])).has(row.id))
      ) {
        throw new ConflictException(
          'Ce CV est déjà en cours d’analyse : son score arrive dans un instant.',
        );
      }
    }
    return this.analyse(profileId, offerId, applicationId, retryFailedBefore);
  }

  /**
   * Scores CVs: one as it arrives, or on request those of the offer not yet
   * read, up to what the plan takes at once. Each uses one of its « CV
   * inclus ». They all join the offer's one screening, so they can be compared.
   */
  async analyse(
    profileId: string,
    offerId: string,
    applicationId?: string,
    /** Also those whose analysis failed before then, tried again (capped). */
    retryFailedBefore?: Date,
  ) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) throw new NotFoundException('Organisation introuvable.');
    const e = await this.subscriptions.entitlements(businessId);
    const room = cvBatchRoom(e);
    if (room === 0) {
      throw new ForbiddenException(
        'Vous avez utilisé tous les CV inclus dans votre formule pour cette période. Changez de formule pour en analyser davantage.',
      );
    }
    const where = {
      job_offer_id: offerId,
      job_offer: {
        employer_id: profileId,
        deleted_at: null,
        status: { in: OPEN },
      },
      status: ExternalApplicationStatus.PENDING,
      OR: [
        { cv_resume_id: null },
        ...(retryFailedBefore
          ? [
              {
                cv_resume: {
                  status: CvScreeningResumeStatus.FAILED,
                  updated_at: { lte: retryFailedBefore },
                },
                analysis_attempts: { lt: MAX_ANALYSIS_ATTEMPTS },
              },
            ]
          : []),
      ],
      cv_storage_key: { not: null },
      cv_removed_at: null,
      // Above the plan's file size it would be refused: never sent.
      cv_size_bytes: { lte: e.cvFileMaxMb * 1024 * 1024 },
      ...(applicationId ? { id: applicationId } : {}),
    };
    const now = new Date();
    const [found, total] = await Promise.all([
      this.prisma.externalApplication.findMany({
        where: { ...where, AND: [claimable(now)] },
        orderBy: { created_at: 'asc' },
        take: room,
      }),
      this.prisma.externalApplication.count({ where }),
    ]);
    // Claimed before anything is charged: two runs never charge one CV twice.
    const ids = found.map((a) => a.id);
    if (ids.length > 0) {
      await this.prisma.externalApplication.updateMany({
        where: { id: { in: ids }, AND: [claimable(now)] },
        data: { analysis_claimed_at: now },
      });
    }
    const mine = new Set(
      ids.length === 0
        ? []
        : (
            await this.prisma.externalApplication.findMany({
              where: { id: { in: ids }, analysis_claimed_at: now },
              select: { id: true },
            })
          ).map((a) => a.id),
    );
    const due = found.filter((a) => mine.has(a.id));
    if (due.length === 0) {
      throw new BadRequestException('Aucun CV à analyser.');
    }
    try {
      return await this.analyseClaimed(profileId, offerId, due, total);
    } finally {
      await this.prisma.externalApplication
        .updateMany({
          where: { id: { in: [...mine] }, analysis_claimed_at: now },
          data: { analysis_claimed_at: null },
        })
        .catch(() => undefined);
    }
  }

  /** The CVs this run holds the claim on: read, sent, then linked. */
  private async analyseClaimed(
    profileId: string,
    offerId: string,
    due: Prisma.ExternalApplicationGetPayload<object>[],
    total: number,
  ) {
    // The application's id in the file name: it finds its resume again below.
    const files = await Promise.all(
      due.map(async (a) => ({
        originalname: `${a.first_name} ${a.last_name} ${a.id}.${CV_EXTENSION[a.cv_mime_type as CvFileType] ?? 'pdf'}`,
        mimetype: a.cv_mime_type,
        size: a.cv_size_bytes,
        buffer: await this.readCv(a),
        tag: a.id,
        // Read with the CV: what the candidate answered when applying,
        // a « Fichier » answer by the text of its file.
        answers: await this.answerFiles.notes(
          Array.isArray(a.answers)
            ? (a.answers as {
                label: string;
                kind: OfferQuestionKind;
                value: string;
                passed?: boolean | null;
              }[])
            : [],
        ),
      })),
    );

    const screening = await this.screenings.addToOffer(
      profileId,
      offerId,
      files,
    );
    for (const a of due) {
      const resumeId = screening.resumeIds.get(a.id);
      if (!resumeId) continue;
      const linked = await this.prisma.externalApplication.update({
        where: { id: a.id },
        data: { cv_resume_id: resumeId, analysis_attempts: { increment: 1 } },
        select: { pool_expires_at: true },
      });
      // An import read before this link was written: its contact is taken now.
      if (a.origin === ExternalApplicationOrigin.IMPORT) {
        const read = await this.prisma.cvScreeningResume.findUnique({
          where: { id: resumeId },
          select: { status: true, candidate: true },
        });
        if (read?.status === CvScreeningResumeStatus.SCORED) {
          await fillImportedContact(
            this.prisma,
            resumeId,
            read.candidate as Parameters<typeof fillImportedContact>[2],
          ).catch(() => undefined);
        }
      }
      // Kept with the candidate's consent: their CV and its analysis last as
      // long, so the business can still find them in « Mes profils ».
      if (linked.pool_expires_at && linked.pool_expires_at > new Date()) {
        await this.prisma.cvScreeningResume.updateMany({
          where: {
            id: resumeId,
            OR: [
              { expires_at: null },
              { expires_at: { lt: linked.pool_expires_at } },
            ],
          },
          data: { expires_at: linked.pool_expires_at },
        });
      }
      // The failed try it replaces: gone, rather than a dead row in the screening.
      if (a.cv_resume_id) {
        await this.prisma.cvScreeningResume
          .delete({ where: { id: a.cv_resume_id } })
          .catch(() => undefined);
      }
    }
    return {
      screeningId: screening.screeningId,
      analysed: due.length,
      left: total - due.length,
    };
  }

  private async readCv(a: {
    cv_storage_key: string | null;
    cv_storage_bucket: string | null;
  }): Promise<Buffer> {
    const { body } = await this.storage.download(a.cv_storage_key as string, {
      bucket: a.cv_storage_bucket ?? undefined,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  // ── Admin (rabotka-admin) ────────────────────────────────────────────

  /**
   * Every careers-page application, across businesses, for admin: newest
   * first, by offer, business, status or a search on the candidate.
   */
  async listForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: ExternalApplicationStatus[];
    jobOfferId?: string;
    employerId?: string;
  }) {
    const q = params.q?.trim();
    const where: Prisma.ExternalApplicationWhereInput = {
      ...(params.status?.length ? { status: { in: params.status } } : {}),
      ...(params.jobOfferId ? { job_offer_id: params.jobOfferId } : {}),
      ...(params.employerId
        ? { job_offer: { employer_id: params.employerId } }
        : {}),
      ...(q
        ? {
            OR: [
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { job_offer: { title: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.externalApplication.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
        include: {
          job_offer: {
            select: {
              id: true,
              title: true,
              employer_id: true,
              employer: { select: { business: { select: { name: true } } } },
            },
          },
          cv_resume: { select: { score: true } },
        },
      }),
      this.prisma.externalApplication.count({ where }),
    ]);
    return {
      data: rows.map((a) => ({
        id: a.id,
        firstName: a.first_name,
        lastName: a.last_name,
        email: a.email,
        phone: a.phone,
        status: a.status,
        source: a.source,
        knockedOut: a.knocked_out,
        answers: (Array.isArray(a.answers)
          ? (a.answers as {
              label: string;
              kind: OfferQuestionKind;
              value: string;
            }[])
          : []
        ).map((x) => ({ label: x.label, value: answerText(x) })),
        hasCv: a.cv_storage_key !== null,
        // So admin's viewer knows how to draw it (PDF, Word, photo).
        cvMimeType: a.cv_mime_type,
        score: a.cv_resume?.score ?? null,
        createdAt: a.created_at.toISOString(),
        viewedAt: a.viewed_at?.toISOString() ?? null,
        retainedAt: a.retained_at?.toISOString() ?? null,
        refusedAt: a.refused_at?.toISOString() ?? null,
        offer: { id: a.job_offer.id, title: a.job_offer.title },
        business: {
          profileId: a.job_offer.employer_id,
          name: a.job_offer.employer.business?.name ?? null,
        },
      })),
      total,
      page: params.page,
      limit: params.limit,
    };
  }

  /** The CV for admin: the business's « vue » is left as it was. */
  async cvFileForAdmin(id: string) {
    const application = await this.prisma.externalApplication.findUnique({
      where: { id },
    });
    if (!application) throw new NotFoundException('Application not found.');
    if (!application.cv_storage_key || application.cv_removed_at) {
      throw new NotFoundException('This CV was deleted.');
    }
    const downloaded = await this.storage.download(application.cv_storage_key, {
      bucket: application.cv_storage_bucket ?? undefined,
    });
    return {
      ...downloaded,
      contentType: application.cv_mime_type,
      filename: `cv-${application.id.slice(0, 8)}.${CV_EXTENSION[application.cv_mime_type as CvFileType] ?? 'bin'}`,
    };
  }

  async cvFile(profileId: string, id: string) {
    const application = await this.owned(profileId, id);
    if (!application.cv_storage_key || application.cv_removed_at) {
      throw new NotFoundException(
        application.cv_removed_at
          ? 'Ce CV a été supprimé par votre équipe.'
          : 'Ce CV a été supprimé à la fin de sa durée de conservation.',
      );
    }
    const downloaded = await this.storage.download(application.cv_storage_key, {
      bucket: application.cv_storage_bucket ?? undefined,
    });
    if (!application.viewed_at) {
      await this.prisma.externalApplication.update({
        where: { id },
        data: { viewed_at: new Date() },
      });
    }
    return {
      ...downloaded,
      contentType: application.cv_mime_type,
      // Not the candidate's own name: it goes in a header, and they typed it.
      filename: `cv-${application.id.slice(0, 8)}.${CV_EXTENSION[application.cv_mime_type as CvFileType] ?? 'bin'}`,
    };
  }

  async retain(profileId: string, id: string) {
    const application = await this.owned(profileId, id);
    if (application.status === ExternalApplicationStatus.REFUSED) {
      throw new BadRequestException('Cette candidature a été refusée.');
    }
    if (application.status === ExternalApplicationStatus.RETAINED) {
      return { retained: true };
    }
    const offerId = application.job_offer_id;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${offerId}::uuid FOR UPDATE`;
      const offer = await tx.jobOffer.findUnique({
        where: { id: offerId },
        select: { status: true, quantity: true, deleted_at: true },
      });
      if (!offer || offer.deleted_at || !OPEN.includes(offer.status)) {
        throw new BadRequestException('Cette offre ne recrute plus.');
      }
      const taken = (await takenSeats(tx, offerId)) + 1;
      if (taken > offer.quantity) {
        throw new ConflictException(
          'Tous les postes de cette offre sont déjà pourvus.',
        );
      }
      await tx.externalApplication.update({
        where: { id },
        data: {
          status: ExternalApplicationStatus.RETAINED,
          retained_at: new Date(),
        },
      });
      await tx.jobOffer.update({
        where: { id: offerId },
        data: {
          status:
            taken >= offer.quantity
              ? JobOfferStatus.FILLED
              : JobOfferStatus.PARTIALLY_FILLED,
        },
      });
    });
    const name = await this.businessName(profileId);
    const language = offerLanguage(application.job_offer);
    void this.send(
      application.email,
      externalApplicationSubject.update(name, language),
      applicationRetainedEmail(
        application.first_name,
        name,
        application.job_offer.title,
        language,
      ),
      language,
    );
    return { retained: true };
  }

  /**
   * Takes a retention back (a mistaken click, a candidate who fell through):
   * the candidate is waiting again, the post is free, the offer recruits
   * again, and the candidate is told. Only while the offer still recruits:
   * a started or ended one is past it.
   */
  async unretain(profileId: string, id: string) {
    const application = await this.owned(profileId, id);
    if (application.status !== ExternalApplicationStatus.RETAINED) {
      throw new ConflictException("Cette candidature n'est pas retenue.");
    }
    const offerId = application.job_offer_id;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "job_offers" WHERE id = ${offerId}::uuid FOR UPDATE`;
      const offer = await tx.jobOffer.findUnique({
        where: { id: offerId },
        select: { status: true, quantity: true, deleted_at: true },
      });
      if (
        !offer ||
        offer.deleted_at ||
        (!OPEN.includes(offer.status) && offer.status !== JobOfferStatus.FILLED)
      ) {
        throw new BadRequestException('Cette offre ne recrute plus.');
      }
      const { count } = await tx.externalApplication.updateMany({
        where: { id, status: ExternalApplicationStatus.RETAINED },
        data: { status: ExternalApplicationStatus.PENDING, retained_at: null },
      });
      if (count === 0) {
        throw new ConflictException("Cette candidature n'est pas retenue.");
      }
      const taken = await takenSeats(tx, offerId);
      await tx.jobOffer.update({
        where: { id: offerId },
        data: {
          status:
            taken === 0
              ? JobOfferStatus.ACTIVE
              : taken >= offer.quantity
                ? JobOfferStatus.FILLED
                : JobOfferStatus.PARTIALLY_FILLED,
        },
      });
    });
    const name = await this.businessName(profileId);
    const language = offerLanguage(application.job_offer);
    void this.send(
      application.email,
      externalApplicationSubject.update(name, language),
      applicationRetainCancelledEmail(
        application.first_name,
        name,
        application.job_offer.title,
        language,
      ),
      language,
    );
    return { retained: false };
  }

  /** A closed offer: those still waiting hear it, as Rabotka's candidates do. */
  @OnEvent(JOB_OFFER_CLOSED)
  async refuseWaiting({ jobOfferId }: JobOfferClosedEvent) {
    await refuseOutsideCandidates(
      { prisma: this.prisma, mail: this.mail, layout: this.layout },
      { job_offer_id: jobOfferId },
      (err) => this.logger.warn(`Careers mail failed: ${String(err)}`),
    );
  }

  async refuse(profileId: string, id: string, message?: string) {
    const application = await this.owned(profileId, id);
    if (application.status === ExternalApplicationStatus.RETAINED) {
      // Said, rather than a quiet { refused: false } the screen took for done.
      throw new ConflictException(
        'Ce candidat est retenu : annulez d’abord la décision.',
      );
    }
    if (application.status !== ExternalApplicationStatus.PENDING) {
      return {
        refused: application.status === ExternalApplicationStatus.REFUSED,
      };
    }
    const refusalMessage = message?.trim() || null;
    await this.prisma.externalApplication.update({
      where: { id },
      data: {
        status: ExternalApplicationStatus.REFUSED,
        refused_at: new Date(),
        refusal_message: refusalMessage,
      },
    });
    const name = await this.businessName(profileId);
    const language = offerLanguage(application.job_offer);
    void this.send(
      application.email,
      externalApplicationSubject.update(name, language),
      applicationRefusedEmail(
        application.first_name,
        name,
        application.job_offer.title,
        refusalMessage,
        language,
      ),
      language,
    );
    return { refused: true };
  }

  /** Until when a consenting candidate is kept, and their withdrawal token. */
  private async poolTerms(now: Date) {
    const months = await this.systemConfig.getTalentPoolMonths();
    const expiresAt = new Date(now);
    expiresAt.setMonth(expiresAt.getMonth() + months);
    const token = randomBytes(24).toString('base64url');
    return { expiresAt, token, tokenHash: poolTokenHash(token) };
  }

  /** The candidate's « retirer ma candidature » page. */
  private withdrawUrl(token: string): string {
    return `${businessSiteUrl()}/carrieres/retrait/${token}`;
  }

  /**
   * « Retirer ma candidature de la liste » from the e-mail link: the
   * consent ends at once, the business no longer keeps or finds them. They
   * stay a candidate of the offer while it recruits; their CV goes as it
   * closes.
   */
  async withdrawFromPool(token: string) {
    const application = await this.prisma.externalApplication.findUnique({
      where: { pool_token_hash: poolTokenHash(token) },
      select: {
        id: true,
        cv_resume_id: true,
        job_offer: { select: { title: true } },
      },
    });
    if (!application) {
      throw new NotFoundException('Ce lien n’est plus valable.');
    }
    await this.prisma.$transaction([
      this.prisma.externalApplication.update({
        where: { id: application.id },
        data: {
          pool_consent_at: null,
          pool_expires_at: null,
          pool_token_hash: null,
          // Their CV goes as this offer closes (CvRetentionService).
          pool_withdrawn_at: new Date(),
        },
      }),
      this.prisma.businessTalent.deleteMany({
        where: {
          OR: [
            { external_application_id: application.id },
            ...(application.cv_resume_id
              ? [{ cv_resume_id: application.cv_resume_id }]
              : []),
          ],
        },
      }),
    ]);
    return { withdrawn: true, jobTitle: application.job_offer.title };
  }

  private async businessName(profileId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { name: true },
    });
    return business?.name ?? 'Le recruteur';
  }

  private async owned(profileId: string, id: string) {
    const application = await this.prisma.externalApplication.findFirst({
      where: { id, job_offer: { employer_id: profileId } },
      include: {
        job_offer: { select: { title: true, description: true } },
      },
    });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    return application;
  }

  private alreadyApplied() {
    return new ConflictException('Vous avez déjà postulé à cette offre.');
  }

  /** `answers` is JSON inside a multipart form. */
  private parseAnswers(raw: string | undefined): AnswerInput[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as AnswerInput[];
    } catch {
      // The same answer as for any other malformed value, below.
    }
    throw new BadRequestException('Réponses illisibles. Réessayez.');
  }

  /** Never fails the action behind it: the application is already saved. */
  private async send(
    to: string | null,
    subject: string,
    content: string,
    language: MailLanguage = 'fr',
  ) {
    if (!to) return;
    try {
      await this.mail.sendMail({
        to,
        subject,
        html: await this.layout.wrap(content, {
          previewText: subject,
          product: 'business',
          language,
        }),
      });
    } catch (err) {
      this.logger.warn(`Careers mail failed: ${String(err)}`);
    }
  }

  /**
   * The business behind a slug: its current one, or one it had before a
   * rename. The view then carries the current slug, and the site redirects
   * the old address to it.
   */
  private async business(slug: string) {
    const live = {
      deleted_at: null,
      verification_status: VerificationStatus.VERIFIED,
    };
    const business =
      (await this.prisma.business.findFirst({
        where: { public_slug: slug, ...live },
        select: COMPANY_SELECT,
      })) ??
      (await this.prisma.business.findFirst({
        where: { previous_slugs: { has: slug }, ...live },
        select: COMPANY_SELECT,
      }));
    if (!business) throw new NotFoundException('Page introuvable.');
    return business;
  }

  private openOffers(employerId: string) {
    return { ...this.openNow(), employer_id: employerId };
  }

  /** Open and not past its closing date, which the expiry job may not have reached. */
  private openNow() {
    return {
      status: { in: OPEN },
      deleted_at: null,
      OR: [{ scheduled_at: null }, { scheduled_at: { gte: new Date() } }],
    };
  }

  private companyView(b: {
    public_slug: string | null;
    name: string;
    category: keyof typeof BUSINESS_CATEGORY_LABELS;
    city: string | null;
    website: string | null;
    description: string | null;
    distribute_offers: boolean;
    cover_url: string | null;
    photos: string[];
    benefits: string[];
    is_partner: boolean;
    profile: { avatar_url: string | null };
  }) {
    return {
      slug: b.public_slug,
      name: b.name,
      logoUrl: b.profile.avatar_url,
      categoryLabel: BUSINESS_CATEGORY_LABELS[b.category],
      city: b.city,
      website: b.website,
      description: b.description,
      // Search engines may list its pages: it has not opted out.
      indexable: b.distribute_offers,
      coverUrl: b.cover_url,
      photos: b.photos,
      benefits: b.benefits,
      partner: b.is_partner,
    };
  }

  private offerView(o: {
    reference: string;
    title: string;
    employment_type: string;
    scheduled_at: Date | null;
    is_remote: boolean;
    city: string | null;
    country_code: string | null;
    country_name: string | null;
    quantity: number;
    created_at: Date;
  }) {
    return {
      reference: o.reference,
      publishedAt: o.created_at.toISOString(),
      title: o.title,
      employmentType: o.employment_type,
      closesAt: o.scheduled_at?.toISOString() ?? null,
      isRemote: o.is_remote,
      city: o.city,
      /** ISO 3166-1, as Google for Jobs wants the country of a job. */
      countryCode: o.country_code,
      countryName: o.country_name,
      quantity: o.quantity,
    };
  }
}

/** Only the hash of a withdrawal link is stored, as for interview links. */
function poolTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
