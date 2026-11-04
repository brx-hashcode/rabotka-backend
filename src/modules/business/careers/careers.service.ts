import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  ExternalApplicationStatus,
  JobOfferStatus,
  OfferQuestionKind,
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { kycBucket } from '../../../common/services/storage/kyc-bucket';
import { StorageService } from '../../../common/services/storage/storage.service';
import {
  answerText,
  type AnswerInput,
  candidateQuestion,
  checkAnswers,
} from '../../job-offer/offer-questions';
import { businessSiteUrl, businessDashboardUrl } from '../../mail/audience';
import { LayoutService } from '../../mail/layout.service';
import { MailService } from '../../mail/mail.service';
import {
  applicationReceivedEmail,
  applicationRefusedEmail,
  applicationRetainedEmail,
  newExternalApplicationEmail,
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
import { CvScreeningService } from '../cv-screening/cv-screening.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  CV_EXTENSION,
  cvFileType,
  type CvFileType,
  DOCX_MIME,
} from '../cv-screening/cv-files';
import type { ApplyDto } from './dto/apply.dto';

const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

const MAX_COMPANIES = 200;
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
  profile: { select: { avatar_url: true } },
} as const;

const OFFER_SELECT = {
  reference: true,
  title: true,
  employment_type: true,
  scheduled_at: true,
  is_remote: true,
  city: true,
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
  ) {}

  /** Verified businesses that are hiring now, those with the most offers first. */
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
    return businesses
      .map((b) => ({
        ...this.companyView(b),
        openOffers: counts.get(b.profile_id) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.openOffers - a.openOffers || a.name.localeCompare(b.name, 'fr'),
      )
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
      },
    };
  }

  /** An application from someone with no account: a CV and their answers. */
  async apply(
    slug: string,
    reference: string,
    file: Express.Multer.File | undefined,
    dto: ApplyDto,
  ) {
    // The field only a bot fills: it is told it worked, and nothing is kept.
    if (dto.website) return { sent: true };

    const business = await this.business(slug);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { ...this.openOffers(business.profile_id), reference },
      select: {
        id: true,
        title: true,
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

    const { rows, knockedOut } = checkAnswers(
      offer.questions,
      this.parseAnswers(dto.answers),
    );

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
    void this.send(
      email,
      `Candidature envoyée à ${business.name}`,
      applicationReceivedEmail(firstName, business.name, offer.title),
    );
    void this.send(
      business.email,
      `Nouvelle candidature : ${offer.title}`,
      newExternalApplicationEmail(
        name,
        offer.title,
        // The offer, where its candidates are, rather than every candidature.
        `${businessDashboardUrl()}/offres/${offer.id}`,
      ),
    );
    // Scored at once, on the plan's « CV inclus ». The candidate is not kept
    // waiting, and a plan with none left simply shows the CV unscored.
    void this.analyse(business.profile_id, offer.id, id).catch((err) =>
      this.logger.warn(`Automatic analysis of ${id} failed: ${String(err)}`),
    );
    return { sent: true };
  }

  /** The business's own: newest first, a failed « éliminatoire » after the others. */
  async listForBusiness(profileId: string) {
    const rows = await this.prisma.externalApplication.findMany({
      where: { job_offer: { employer_id: profileId, deleted_at: null } },
      orderBy: [{ knocked_out: 'asc' }, { created_at: 'desc' }],
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
            screening_id: true,
          },
        },
      },
    });
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
      ).map((x) => ({ ...x, value: answerText(x) })),
      knockedOut: a.knocked_out,
      source: a.source,
      hasCv: a.cv_storage_key !== null,
      cvFileName: a.cv_file_name,
      cvMimeType: a.cv_mime_type,
      createdAt: a.created_at.toISOString(),
      viewedAt: a.viewed_at?.toISOString() ?? null,
      offer: a.job_offer,
      analysis: a.cv_resume && {
        resumeId: a.cv_resume.id,
        screeningId: a.cv_resume.screening_id,
        status: a.cv_resume.status,
        score: a.cv_resume.score,
        summary: a.cv_resume.summary,
        strengths: a.cv_resume.strengths,
        gaps: a.cv_resume.gaps,
        criteria: a.cv_resume.criteria,
      },
    }));
  }

  /**
   * Scores CVs: one as it arrives, or on request those of the offer not yet
   * read, up to what the plan takes at once. Each uses one of its « CV
   * inclus ». They all join the offer's one screening, so they can be compared.
   */
  async analyse(profileId: string, offerId: string, applicationId?: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) throw new NotFoundException('Organisation introuvable.');
    const e = await this.subscriptions.entitlements(businessId);
    const where = {
      job_offer_id: offerId,
      job_offer: {
        employer_id: profileId,
        deleted_at: null,
        status: { in: OPEN },
      },
      status: ExternalApplicationStatus.PENDING,
      cv_resume_id: null,
      cv_storage_key: { not: null },
      ...(applicationId
        ? { id: applicationId }
        : { cv_size_bytes: { lte: e.cvFileMaxMb * 1024 * 1024 } }),
    };
    const [due, total] = await Promise.all([
      this.prisma.externalApplication.findMany({
        where,
        orderBy: { created_at: 'asc' },
        take: e.cvBatchMax,
      }),
      this.prisma.externalApplication.count({ where }),
    ]);
    if (due.length === 0) {
      throw new BadRequestException('Aucun CV à analyser.');
    }

    // The application's id in the file name: it finds its resume again below.
    const files = await Promise.all(
      due.map(async (a) => ({
        originalname: `${a.first_name} ${a.last_name} ${a.id}.${CV_EXTENSION[a.cv_mime_type as CvFileType] ?? 'pdf'}`,
        mimetype: a.cv_mime_type,
        size: a.cv_size_bytes,
        buffer: await this.readCv(a),
        tag: a.id,
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
      await this.prisma.externalApplication.update({
        where: { id: a.id },
        data: { cv_resume_id: resumeId },
      });
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
    if (!application.cv_storage_key) {
      throw new NotFoundException(
        'This CV was deleted at the end of its retention.',
      );
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
    if (!application.cv_storage_key) {
      throw new NotFoundException(
        'Ce CV a été supprimé à la fin de sa durée de conservation.',
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
    void this.send(
      application.email,
      `Votre candidature chez ${name}`,
      applicationRetainedEmail(
        application.first_name,
        name,
        application.job_offer.title,
      ),
    );
    return { retained: true };
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
    void this.send(
      application.email,
      `Votre candidature chez ${name}`,
      applicationRefusedEmail(
        application.first_name,
        name,
        application.job_offer.title,
        refusalMessage,
      ),
    );
    return { refused: true };
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
      include: { job_offer: { select: { title: true } } },
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
  private async send(to: string | null, subject: string, content: string) {
    if (!to) return;
    try {
      await this.mail.sendMail({
        to,
        subject,
        html: await this.layout.wrap(content, {
          previewText: subject,
          product: 'business',
        }),
      });
    } catch (err) {
      this.logger.warn(`Careers mail failed: ${String(err)}`);
    }
  }

  private async business(slug: string) {
    const business = await this.prisma.business.findFirst({
      where: {
        public_slug: slug,
        deleted_at: null,
        verification_status: VerificationStatus.VERIFIED,
      },
      select: COMPANY_SELECT,
    });
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
    };
  }

  private offerView(o: {
    reference: string;
    title: string;
    employment_type: string;
    scheduled_at: Date | null;
    is_remote: boolean;
    city: string | null;
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
      countryName: o.country_name,
      quantity: o.quantity,
    };
  }
}
