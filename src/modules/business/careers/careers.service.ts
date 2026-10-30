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
  Prisma,
  VerificationStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { kycBucket } from '../../../common/services/storage/kyc-bucket';
import { StorageService } from '../../../common/services/storage/storage.service';
import {
  type AnswerInput,
  candidateQuestion,
  checkAnswers,
} from '../../job-offer/offer-questions';
import { businessDashboardUrl } from '../../mail/audience';
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
      select: { id: true },
    });
    if (seen) throw this.alreadyApplied();

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
        `${businessDashboardUrl()}/candidatures`,
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
      where: { job_offer: { employer_id: profileId } },
      orderBy: [{ knocked_out: 'asc' }, { created_at: 'desc' }],
      include: {
        job_offer: { select: { id: true, title: true } },
        cv_resume: {
          select: {
            id: true,
            status: true,
            score: true,
            summary: true,
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
      answers: a.answers,
      knockedOut: a.knocked_out,
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
      job_offer: { employer_id: profileId, deleted_at: null },
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
      })),
    );

    const open = await this.prisma.cvScreening.findFirst({
      where: {
        business_id: businessId,
        offer_id: offerId,
        external: true,
        purged_at: null,
        expires_at: { gt: new Date() },
      },
      select: { id: true },
    });
    const screening = await this.screenings.create(
      profileId,
      files,
      { offerId },
      open?.id,
    );
    if (!open) {
      await this.prisma.cvScreening.update({
        where: { id: screening.id },
        data: { external: true },
      });
    }
    for (const a of due) {
      const resume = screening.resumes.find((r) => r.fileName.includes(a.id));
      if (!resume) continue;
      await this.prisma.externalApplication.update({
        where: { id: a.id },
        data: { cv_resume_id: resume.id },
      });
      await this.prisma.cvScreeningResume.update({
        where: { id: resume.id },
        data: { file_name: resume.fileName.replace(` ${a.id}`, '') },
      });
    }
    return {
      screeningId: screening.id,
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
    await this.prisma.externalApplication.update({
      where: { id },
      data: {
        status: ExternalApplicationStatus.RETAINED,
        retained_at: new Date(),
      },
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
  async refuseWaiting({ jobOfferId, employerId }: JobOfferClosedEvent) {
    const waiting = await this.prisma.externalApplication.findMany({
      where: {
        job_offer_id: jobOfferId,
        status: ExternalApplicationStatus.PENDING,
      },
      select: { id: true },
    });
    for (const { id } of waiting) {
      await this.refuse(employerId, id, 'Cette offre est maintenant fermée.');
    }
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
  }) {
    return {
      reference: o.reference,
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
