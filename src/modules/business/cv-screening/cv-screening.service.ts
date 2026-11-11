import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { answerSnippet } from './lenient-answer';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  CvScreeningResumeStatus,
  CvScreeningStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { StorageService } from '../../../common/services/storage/storage.service';
import { kycBucket } from '../../../common/services/storage/kyc-bucket';
import { CV_SCREENING_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { LlmService } from '../../rag/llm/llm.service';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import {
  BusinessSubscriptionService,
  TRIAL_AI_REFUSAL,
} from '../subscription/business-subscription.service';
import {
  CV_EXTENSION,
  MIN_TEXT_CHARS,
  cvFileType,
  extractCvText,
  foldWhitespace,
  type CvFileType,
} from './cv-files';
import {
  JSON_REMINDER,
  assessmentMessages,
  overallScore,
  parseAssessment,
  readApplicationAnswers,
  type ApplicationAnswerNote,
  type CvAssessment,
  type CvCandidate,
  type CvSource,
} from './cv-assessment';
import {
  CV_SCREENING_PROGRESS,
  type CvScreeningProgress,
} from './cv-screening.events';

export type CvScreeningJob = { resumeId: string };

/** How long a CV from a public careers page is kept. */
const EXTERNAL_CV_RETENTION_DAYS = 90;

/** One uploaded file, as multer hands it over. */
export type CvUpload = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
  /**
   * Set by server code only, for a CV it wrote (an applicant's, as text):
   * multer never sets it, so an upload is always sniffed.
   */
  internalType?: CvFileType;
  /** Server code only: the answers of the application this CV came with. */
  answers?: ApplicationAnswerNote[];
};

const EMPLOYMENT_LABEL: Record<string, string> = {
  MISSION: 'Mission',
  CDD: 'CDD',
  CDI: 'CDI',
  STAGE: 'Stage',
};

/** A CV still waiting this long is stuck (a lost job): given up and given back. */
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Per model attempt. A CV is answered in 10–20 s; past 45 s the model is
 * stuck (gemini-3.6-flash was seen hanging the full 90 s the first version
 * allowed), and the next one in the chain should get its turn.
 */
const LLM_TIMEOUT_MS = 45_000;

/** As much of a transcribed CV as is kept, like the text read from a PDF. */
const MAX_TRANSCRIPT_CHARS = 15_000;

type ScreeningRow = Prisma.CvScreeningGetPayload<{
  include: { resumes: true };
}>;
type ResumeRow = ScreeningRow['resumes'][number];

/**
 * « Analyse de CV »: a business uploads CVs for one job, the AI reads and scores
 * each against it, and the list comes back ranked. Paid for by the plan's
 * « CV inclus »; a CV that cannot be read is given back. Files and contact
 * details are purged after the plan's retention; scores stay.
 */
@Injectable()
export class CvScreeningService {
  private readonly logger = new Logger(CvScreeningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly llm: LlmService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Creating ─────────────────────────────────────────────────────────

  async create(
    profileId: string,
    files: CvUpload[],
    job: { offerId?: string; jobTitle?: string; jobText?: string },
    /** Adds to this screening instead of opening a new one. */
    into?: string,
  ) {
    const businessId = await this.requireBusiness(profileId);
    const e = await this.subscriptions.entitlements(businessId);
    // Not in the plan, and no pack bought: refused before reading the files.
    if (
      e.cvQuota === 0 &&
      (e.cvRemaining === 0 || e.trialLocked.includes('cvAnalysis'))
    ) {
      throw new ForbiddenException(
        e.trialLocked.includes('cvAnalysis')
          ? TRIAL_AI_REFUSAL
          : 'L’analyse de CV est incluse dans les formules supérieures. Changez de formule depuis votre espace, rubrique « Abonnement ».',
      );
    }
    if (files.length === 0) {
      throw new BadRequestException('Ajoutez au moins un CV.');
    }
    if (files.length > e.cvBatchMax) {
      throw new BadRequestException(
        `Votre formule permet ${e.cvBatchMax} CV par analyse : retirez-en ${files.length - e.cvBatchMax}.`,
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
      const type = file.internalType ?? cvFileType(file.buffer, file.mimetype);
      if (!type) {
        throw new BadRequestException(
          `« ${name} » n'est pas reconnu : envoyez un PDF, un fichier Word (.docx) ou une photo (JPG, PNG, WEBP).`,
        );
      }
      return { file, type, name };
    });

    const brief = await this.jobBrief(profileId, job);
    const { subscriptionId } = await this.subscriptions.consumeCv(
      businessId,
      files.length,
    );

    const id = randomUUID();
    const uploaded: { key: string; bucket: string }[] = [];
    try {
      const bucket = await kycBucket(this.systemConfig, this.config);
      for (const { file, type } of typed) {
        const result = await this.storage.upload(
          file.buffer,
          `${randomUUID()}.${CV_EXTENSION[type]}`,
          {
            folder: `cv-screenings/${businessId}/${id}`,
            mimeType: type,
            access: 'private',
            bucket,
          },
        );
        uploaded.push({ key: result.key, bucket });
      }
    } catch (err) {
      await this.subscriptions.releaseCv(subscriptionId, files.length);
      await this.deleteObjects(uploaded);
      this.logger.error(`CV upload failed for business ${businessId}`, err);
      throw new BadRequestException(
        "L'envoi des CV a échoué. Réessayez dans un instant.",
      );
    }

    let screening: ScreeningRow;
    try {
      const plan = await this.prisma.businessSubscription.findUnique({
        where: { id: subscriptionId },
        select: { plan: { select: { cv_retention_days: true } } },
      });
      const retentionDays = plan?.plan.cv_retention_days ?? 30;
      // Each CV keeps its file as long as the plan it was charged to says.
      const expiresAt = new Date(
        Date.now() + retentionDays * 24 * 60 * 60 * 1000,
      );

      const resumes = typed.map(({ file, type, name }, i) => ({
        file_name: name.slice(0, 200),
        mime_type: type,
        size_bytes: file.size,
        storage_key: uploaded[i].key,
        storage_bucket: uploaded[i].bucket,
        // Charged now, to this period: given back here if it can't be read.
        subscription_id: subscriptionId,
        expires_at: expiresAt,
        // Read with the CV: the answers it came with, when it is an application's.
        ...(file.answers?.length ? { application_answers: file.answers } : {}),
      }));
      if (into) {
        // The offer's screening stays open as long as its latest CV.
        await this.prisma.cvScreening.updateMany({
          where: { id: into, expires_at: { lt: expiresAt } },
          data: { expires_at: expiresAt },
        });
      }
      screening = into
        ? await this.prisma.cvScreening.update({
            where: { id: into },
            data: {
              status: CvScreeningStatus.PROCESSING,
              resumes: { create: resumes },
            },
            include: { resumes: true },
          })
        : await this.prisma.cvScreening.create({
            data: {
              id,
              business_id: businessId,
              subscription_id: subscriptionId,
              offer_id: brief.offerId,
              job_title: brief.title,
              job_text: brief.text,
              expires_at: expiresAt,
              resumes: { create: resumes },
            },
            include: { resumes: true },
          });
    } catch (err) {
      // Not saved: the CVs go back to the plan and their files are deleted,
      // rather than charged for nothing and left in the bucket.
      await this.subscriptions.releaseCv(subscriptionId, files.length);
      await this.deleteObjects(uploaded);
      this.logger.error(
        `CV screening not saved for business ${businessId}`,
        err,
      );
      throw new BadRequestException(
        "L'envoi des CV a échoué. Réessayez dans un instant.",
      );
    }

    const fresh = new Set(uploaded.map((u) => u.key));
    for (const resume of screening.resumes) {
      if (!resume.storage_key || !fresh.has(resume.storage_key)) continue;
      try {
        await this.queue.addJob<CvScreeningJob>(CV_SCREENING_QUEUE, {
          resumeId: resume.id,
        });
      } catch (err) {
        // Never queued, never read: settled (and given back) now, rather
        // than « en cours » until the stuck sweep two hours later.
        this.logger.error(`CV ${resume.id} could not be queued`, err);
        await this.settle(
          {
            ...resume,
            screening: {
              id: screening.id,
              subscription_id: screening.subscription_id,
            },
          },
          { status: 'FAILED', error: "L'analyse n'a pas abouti." },
        );
      }
    }
    return screeningDetail(screening);
  }

  /**
   * More CVs for a screening the business opened by hand: a batch too large
   * for one request (the business site takes 50 MB a request) is sent in
   * several, the first opening the screening, the next adding to it. Each
   * request is charged on its own, all or nothing; the plan's « CV par
   * analyse » counts for the whole screening.
   */
  async addFiles(profileId: string, screeningId: string, files: CvUpload[]) {
    const businessId = await this.requireBusiness(profileId);
    const screening = await this.prisma.cvScreening.findFirst({
      where: { id: screeningId, business_id: businessId },
      select: {
        id: true,
        external: true,
        offer_id: true,
        job_title: true,
        job_text: true,
        purged_at: true,
        expires_at: true,
        _count: { select: { resumes: true } },
      },
    });
    if (!screening) throw new NotFoundException('Analyse introuvable.');
    // The offer's shared screening fills itself from the careers page.
    if (screening.external) {
      throw new BadRequestException(
        'Ajoutez ces CV depuis une nouvelle analyse.',
      );
    }
    if (screening.purged_at || screening.expires_at <= new Date()) {
      throw new BadRequestException(
        'Cette analyse a dépassé sa durée de conservation.',
      );
    }
    const e = await this.subscriptions.entitlements(businessId);
    const total = screening._count.resumes + files.length;
    if (total > e.cvBatchMax) {
      throw new BadRequestException(
        `Votre formule permet ${e.cvBatchMax} CV par analyse : cette analyse en a déjà ${screening._count.resumes}.`,
      );
    }
    return this.create(
      profileId,
      files,
      screening.offer_id
        ? { offerId: screening.offer_id }
        : { jobTitle: screening.job_title, jobText: screening.job_text },
      screening.id,
    );
  }

  /**
   * Adds CVs to the offer's one shared screening (opened on first use): the
   * careers-page CVs and the Rabotka applicants' land together, so any of them
   * can be compared. `tag` is a token in each file name that tells which
   * resume came from which file; it is taken out once they are matched.
   */
  async addToOffer(
    profileId: string,
    offerId: string,
    files: (CvUpload & { tag: string })[],
  ): Promise<{ screeningId: string; resumeIds: Map<string, string> }> {
    const businessId = await this.requireBusiness(profileId);
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
    const screening = await this.create(
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
    const resumeIds = new Map<string, string>();
    for (const file of files) {
      const resume = screening.resumes.find((r) =>
        r.fileName.includes(` ${file.tag}`),
      );
      if (!resume) continue;
      resumeIds.set(file.tag, resume.id);
      await this.prisma.cvScreeningResume.update({
        where: { id: resume.id },
        data: { file_name: resume.fileName.replace(` ${file.tag}`, '') },
      });
    }
    return { screeningId: screening.id, resumeIds };
  }

  /** The job the CVs are measured against: an offer of the business, or one described by hand. */
  private async jobBrief(
    profileId: string,
    job: { offerId?: string; jobTitle?: string; jobText?: string },
  ): Promise<{ offerId: string | null; title: string; text: string }> {
    if (job.offerId) {
      const offer = await this.prisma.jobOffer.findFirst({
        where: { id: job.offerId, employer_id: profileId, deleted_at: null },
        select: {
          id: true,
          title: true,
          description: true,
          employment_type: true,
          city: true,
          country_name: true,
          is_remote: true,
          note: true,
          category: { select: { name: true } },
        },
      });
      if (!offer) throw new NotFoundException('Offre introuvable.');
      const place = offer.is_remote
        ? 'À distance'
        : [offer.city, offer.country_name].filter(Boolean).join(', ');
      const lines = [
        `Type : ${EMPLOYMENT_LABEL[offer.employment_type] ?? offer.employment_type}`,
        offer.category?.name ? `Métier : ${offer.category.name}` : null,
        place ? `Lieu : ${place}` : null,
        '',
        offer.description,
        offer.note ? `\n${offer.note}` : null,
      ].filter((l) => l !== null);
      return {
        offerId: offer.id,
        title: offer.title,
        text: lines.join('\n').slice(0, 8000),
      };
    }
    const title = job.jobTitle?.trim() ?? '';
    const text = job.jobText?.trim() ?? '';
    if (title.length < 3 || text.length < 30) {
      throw new BadRequestException(
        'Choisissez une offre, ou décrivez le poste : un intitulé et au moins quelques lignes sur les missions et le profil recherché.',
      );
    }
    return {
      offerId: null,
      title: title.slice(0, 120),
      text: text.slice(0, 8000),
    };
  }

  // ── Reading ──────────────────────────────────────────────────────────

  async list(profileId: string, page: number, limit: number) {
    const businessId = await this.requireBusiness(profileId);
    const [rows, total] = await Promise.all([
      this.prisma.cvScreening.findMany({
        where: { business_id: businessId },
        include: { resumes: true },
        orderBy: { created_at: 'desc' },
        skip: page * limit,
        take: limit,
      }),
      this.prisma.cvScreening.count({ where: { business_id: businessId } }),
    ]);
    return { items: rows.map(screeningSummary), total };
  }

  async get(profileId: string, id: string) {
    const screening = await this.owned(profileId, id);
    // Which CVs are a Rabotka applicant's: their interview goes on the
    // application (profile e-mail, in-app notice), not on the CV's contacts.
    const links = await this.prisma.application.findMany({
      where: { cv_resume_id: { in: screening.resumes.map((r) => r.id) } },
      select: { id: true, cv_resume_id: true },
    });
    const applicationOf = new Map(links.map((l) => [l.cv_resume_id, l.id]));
    const detail = screeningDetail(screening);
    return {
      ...detail,
      resumes: detail.resumes.map((r) => ({
        ...r,
        applicationId: applicationOf.get(r.id) ?? null,
      })),
    };
  }

  /** One CV's file, for its business only, until the purge. */
  async file(profileId: string, id: string, resumeId: string) {
    const screening = await this.owned(profileId, id);
    const resume = screening.resumes.find((r) => r.id === resumeId);
    if (!resume) throw new NotFoundException('CV introuvable.');
    if (!resume.storage_key) {
      throw new NotFoundException(
        'Ce CV a été supprimé à la fin de sa durée de conservation.',
      );
    }
    const downloaded = await this.storage.download(resume.storage_key, {
      bucket: resume.storage_bucket ?? undefined,
    });
    const ext = CV_EXTENSION[resume.mime_type as CvFileType] ?? 'bin';
    return {
      ...downloaded,
      contentType: resume.mime_type,
      filename: `cv-${resume.id.slice(0, 8)}.${ext}`,
    };
  }

  /** Deletes a screening: its files at once, then its rows. CVs already read are not given back. */
  async remove(profileId: string, id: string): Promise<void> {
    const screening = await this.owned(profileId, id);
    const failed = await this.deleteObjects(
      screening.resumes.flatMap((r) =>
        r.storage_key
          ? [{ key: r.storage_key, bucket: r.storage_bucket ?? undefined }]
          : [],
      ),
    );
    if (failed.size > 0) {
      // The rows go as asked; the keys are in the log to clean up by hand.
      this.logger.error(
        `Screening ${screening.id} deleted; files left in storage: ${[...failed].join(', ')}`,
      );
    }
    await this.prisma.cvScreening.delete({ where: { id: screening.id } });
  }

  private async owned(profileId: string, id: string): Promise<ScreeningRow> {
    const businessId = await this.requireBusiness(profileId);
    const screening = await this.prisma.cvScreening.findFirst({
      where: { id, business_id: businessId },
      include: { resumes: true },
    });
    if (!screening) throw new NotFoundException('Analyse introuvable.');
    return screening;
  }

  private async requireBusiness(profileId: string): Promise<string> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    return businessId;
  }

  // ── The queue's work ─────────────────────────────────────────────────

  /** Reads and scores one CV. Idempotent: a CV already decided is left alone. */
  async process(resumeId: string): Promise<void> {
    const resume = await this.prisma.cvScreeningResume.findUnique({
      where: { id: resumeId },
      include: { screening: true },
    });
    if (!resume || resume.status !== CvScreeningResumeStatus.QUEUED) return;

    let outcome:
      | { status: 'SCORED'; assessment: CvAssessment; text: string | null }
      | { status: 'UNREADABLE' | 'FAILED'; error: string };
    try {
      const source = await this.sourceOf(resume);
      if (!source) {
        outcome = {
          status: 'UNREADABLE',
          error: 'Aucun texte lisible dans ce fichier.',
        };
      } else {
        const assessment = await this.assess(
          {
            title: resume.screening.job_title,
            text: resume.screening.job_text,
          },
          source,
          resume.id,
          readApplicationAnswers(resume.application_answers),
        );
        outcome = !assessment
          ? { status: 'FAILED', error: "L'analyse n'a pas abouti." }
          : !assessment.isCv
            ? {
                status: 'UNREADABLE',
                error:
                  'Ce document ne ressemble pas à un CV, ou il est illisible.',
              }
            : {
                status: 'SCORED',
                assessment,
                // Kept for the CV's chat: no download per question.
                text: source.kind === 'text' ? source.text : null,
              };
      }
    } catch (err) {
      this.logger.warn(
        `CV ${resume.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      outcome = { status: 'FAILED', error: "L'analyse n'a pas abouti." };
    }

    await this.settle(resume, outcome);
  }

  /** Records a CV's outcome, gives back what was not read, and closes the screening after its last CV. */
  private async settle(
    resume: ResumeRow & {
      screening: { id: string; subscription_id: string | null };
    },
    outcome:
      | { status: 'SCORED'; assessment: CvAssessment; text: string | null }
      | { status: 'UNREADABLE' | 'FAILED'; error: string },
  ): Promise<void> {
    const data: Prisma.CvScreeningResumeUpdateManyMutationInput =
      outcome.status === 'SCORED'
        ? {
            status: CvScreeningResumeStatus.SCORED,
            score: overallScore(outcome.assessment.criteria),
            criteria: outcome.assessment.criteria,
            summary: outcome.assessment.summary,
            strengths: outcome.assessment.strengths,
            gaps: outcome.assessment.gaps,
            candidate: outcome.assessment.candidate,
            cv_text: outcome.text,
            error: null,
          }
        : { status: outcome.status, error: outcome.error };
    // Only from QUEUED: a CV the stuck sweep already gave up on stays given up.
    const { count } = await this.prisma.cvScreeningResume.updateMany({
      where: { id: resume.id, status: CvScreeningResumeStatus.QUEUED },
      data,
    });
    if (count === 0) return;
    // Given back to the period it was taken from, not the screening's: an
    // offer's screening outlives a period, and the period may have changed.
    const charged = resume.subscription_id ?? resume.screening.subscription_id;
    if (outcome.status !== 'SCORED' && charged) {
      await this.subscriptions.releaseCv(charged, 1);
    }
    await this.afterProgress(resume.screening.id);
  }

  private async afterProgress(screeningId: string): Promise<void> {
    const screening = await this.prisma.cvScreening.findUnique({
      where: { id: screeningId },
      select: {
        id: true,
        job_title: true,
        status: true,
        external: true,
        business: { select: { profile_id: true } },
        resumes: { select: { status: true, score: true } },
      },
    });
    if (!screening) return;
    const total = screening.resumes.length;
    const done = screening.resumes.filter(
      (r) => r.status !== CvScreeningResumeStatus.QUEUED,
    ).length;
    this.events.emit(CV_SCREENING_PROGRESS, {
      profileId: screening.business.profile_id,
      screeningId: screening.id,
      done,
      total,
    } satisfies CvScreeningProgress);
    if (done < total) return;

    // One CV finishing last closes it; two finishing together cannot both.
    const { count } = await this.prisma.cvScreening.updateMany({
      where: { id: screening.id, status: CvScreeningStatus.PROCESSING },
      data: { status: CvScreeningStatus.DONE },
    });
    if (count === 0) return;
    // An offer's own screening fills as candidates apply: their score shows on
    // the offer, and « Analyse terminée » on each arrival would only be noise.
    if (screening.external) return;
    const scored = screening.resumes.filter(
      (r) => r.status === CvScreeningResumeStatus.SCORED,
    );
    const best = Math.max(0, ...scored.map((r) => r.score ?? 0));
    notifyProfile(this.events, {
      recipientId: screening.business.profile_id,
      input: {
        type: 'CV_SCREENING_DONE',
        screeningId: screening.id,
        jobTitle: screening.job_title,
        scored: scored.length,
        best: scored.length ? best : null,
      },
    });
  }

  /** What the model reads: the text when there is some, else the image or the scanned PDF itself. */
  async sourceOf(resume: ResumeRow): Promise<CvSource | null> {
    if (!resume.storage_key) return null;
    const downloaded = await this.storage.download(resume.storage_key, {
      bucket: resume.storage_bucket ?? undefined,
    });
    const buffer = await toBuffer(downloaded.body);
    const type = resume.mime_type as CvFileType;
    const text = await extractCvText(buffer, type);
    if (text.length >= MIN_TEXT_CHARS) return { kind: 'text', text };
    if (type.startsWith('image/')) {
      return {
        kind: 'image',
        mimeType: type,
        base64: buffer.toString('base64'),
      };
    }
    if (type === 'application/pdf') {
      return { kind: 'pdf', base64: buffer.toString('base64') };
    }
    // A Word file with next to no text: nothing more to look at.
    return text.length > 0 ? { kind: 'text', text } : null;
  }

  /**
   * One CV against the job, through the `document` chain. A scanned PDF goes
   * to the providers that read a PDF (Google) only. A first answer that is not
   * the JSON asked for gets one reminder.
   */
  private async assess(
    job: { title: string; text: string },
    source: CvSource,
    correlationId: string,
    answers: ApplicationAnswerNote[] = [],
  ): Promise<CvAssessment | null> {
    const messages: BaseMessage[] = assessmentMessages(job, source, answers);
    const call = (input: BaseMessage[]) =>
      this.call(input, source, correlationId);

    const first = await call(messages);
    const parsed = parseAssessment(first);
    if (parsed) return parsed;
    const second = await call([
      ...messages,
      new AIMessage(first),
      new HumanMessage(JSON_REMINDER),
    ]);
    const read = parseAssessment(second);
    if (!read) {
      // Logged now: until today a failed CV said only « n'a pas abouti ».
      this.logger.warn(
        `CV ${correlationId} answer unreadable: ${answerSnippet(second)}`,
      );
    }
    return read;
  }

  /**
   * The text of a scan or a photo, written out by the model once, so the CV's
   * chat can read text instead of looking at the file on every question.
   * Null when the model finds nothing legible.
   */
  async transcribe(
    source: CvSource,
    correlationId: string,
  ): Promise<string | null> {
    if (source.kind === 'text') return source.text;
    const media =
      source.kind === 'image'
        ? {
            type: 'image_url' as const,
            image_url: {
              url: `data:${source.mimeType};base64,${source.base64}`,
            },
          }
        : {
            type: 'media' as const,
            mimeType: 'application/pdf',
            data: source.base64,
          };
    const text = await this.call(
      [
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: "Transcris fidèlement tout le texte de ce CV, dans l'ordre, en texte brut, sans commentaire ni mise en forme. S'il est illisible, réponds seulement : ILLISIBLE.",
            },
            media,
          ],
        }),
      ],
      source,
      correlationId,
    );
    const clean = foldWhitespace(text).slice(0, MAX_TRANSCRIPT_CHARS);
    return clean.length < 50 || clean.startsWith('ILLISIBLE') ? null : clean;
  }

  private async call(
    input: BaseMessage[],
    source: CvSource,
    correlationId: string,
  ): Promise<string> {
    const options = {
      tier: 'document' as const,
      timeoutMs: LLM_TIMEOUT_MS,
      correlationId,
    };
    if (source.kind !== 'pdf') {
      const { output } = await this.llm.invoke(input, options);
      return contentText(output.content);
    }
    const chain = (await this.llm.usableChain('document')).filter(
      (spec) => spec.provider === 'google',
    );
    let lastError: unknown = new Error('No provider reads a scanned PDF');
    for (const spec of chain) {
      try {
        const { output } = await this.llm.invokeWith(spec, input, options);
        return contentText(output.content);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  // ── Housekeeping ─────────────────────────────────────────────────────

  /**
   * CVs analysed before the career was read get it now, from the text kept
   * for their chat: the jobs, their durations and the years of experience.
   * The score and the points stay as they were; no CV credit is used. A CV
   * the model can't read for it is marked (an empty career) and not retried;
   * a provider failure is retried on the next run.
   */
  async backfillCareers(limit = 30): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM cv_screening_resumes
      WHERE status = 'SCORED' AND cv_text IS NOT NULL AND cv_text <> ''
        AND (candidate IS NULL OR NOT (candidate ? 'experiences'))
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    let done = 0;
    for (const { id } of rows) {
      const resume = await this.prisma.cvScreeningResume.findUnique({
        where: { id },
        include: { screening: true },
      });
      if (!resume?.cv_text) continue;
      let assessment: CvAssessment | null;
      try {
        assessment = await this.assess(
          {
            title: resume.screening.job_title,
            text: resume.screening.job_text,
          },
          { kind: 'text', text: resume.cv_text },
          resume.id,
          readApplicationAnswers(resume.application_answers),
        );
      } catch (err) {
        this.logger.warn(
          `Career backfill for CV ${resume.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const before =
        resume.candidate &&
        typeof resume.candidate === 'object' &&
        !Array.isArray(resume.candidate)
          ? resume.candidate
          : {};
      const read = assessment?.candidate;
      await this.prisma.cvScreeningResume.update({
        where: { id: resume.id },
        data: {
          candidate: {
            ...before,
            experiences: read?.experiences ?? [],
            experienceMonths: read?.experienceMonths ?? null,
            relevantMonths: read?.relevantMonths ?? null,
            ...(typeof read?.experienceMonths === 'number' && {
              yearsExperience: read.yearsExperience,
            }),
          },
        },
      });
      done++;
    }
    return done;
  }

  /**
   * The periodic sweep: CVs stuck in the queue are given up (and given back),
   * and screenings past their retention lose their files and contact details.
   */
  /** CVs sent from a public careers page go after a while; the row stays. */
  private async purgeExternalCvs(now: Date): Promise<void> {
    const before = new Date(
      now.getTime() - EXTERNAL_CV_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    const due = await this.prisma.externalApplication.findMany({
      where: {
        created_at: { lt: before },
        cv_storage_key: { not: null },
        // A candidate who agreed to be kept keeps their CV that long.
        OR: [{ pool_expires_at: null }, { pool_expires_at: { lte: now } }],
      },
      select: { id: true, cv_storage_key: true, cv_storage_bucket: true },
      take: 200,
    });
    for (const a of due) {
      const failed = await this.deleteObjects([
        {
          key: a.cv_storage_key as string,
          bucket: a.cv_storage_bucket ?? undefined,
        },
      ]);
      // Kept when the delete failed: the next sweep tries again.
      if (failed.size > 0) continue;
      await this.prisma.externalApplication.update({
        where: { id: a.id },
        data: { cv_storage_key: null, cv_storage_bucket: null },
      });
    }
  }

  /**
   * « Garder ma candidature » ran out: the consent ends and the business no
   * longer keeps them. Their CV, kept until that same day, is purged below
   * like any CV past its retention.
   */
  private async endExpiredPool(now: Date): Promise<void> {
    const due = await this.prisma.externalApplication.findMany({
      where: { pool_consent_at: { not: null }, pool_expires_at: { lte: now } },
      select: { id: true, cv_resume_id: true },
      take: 300,
    });
    for (const a of due) {
      await this.prisma.$transaction([
        this.prisma.externalApplication.update({
          where: { id: a.id },
          data: {
            pool_consent_at: null,
            pool_expires_at: null,
            pool_token_hash: null,
          },
        }),
        this.prisma.businessTalent.deleteMany({
          where: {
            OR: [
              { external_application_id: a.id },
              ...(a.cv_resume_id ? [{ cv_resume_id: a.cv_resume_id }] : []),
            ],
          },
        }),
      ]);
    }
  }

  async sweep(now = new Date()): Promise<{ stuck: number; purged: number }> {
    const stuck = await this.prisma.cvScreeningResume.findMany({
      where: {
        status: CvScreeningResumeStatus.QUEUED,
        created_at: { lt: new Date(now.getTime() - STUCK_AFTER_MS) },
      },
      include: { screening: true },
      take: 200,
    });
    for (const resume of stuck) {
      await this.settle(resume, {
        status: 'FAILED',
        error: "L'analyse n'a pas abouti.",
      });
    }

    await this.purgeExternalCvs(now);
    await this.endExpiredPool(now);

    // Each CV past its own retention loses its file, text and contact
    // details; its conversations go with it (they quote the CV). A file the
    // storage would not delete keeps its key, and is tried again next time.
    const due = await this.prisma.cvScreeningResume.findMany({
      where: {
        OR: [{ storage_key: { not: null } }, { cv_text: { not: null } }],
        AND: [
          {
            OR: [
              { expires_at: { lte: now } },
              { expires_at: null, screening: { expires_at: { lte: now } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        screening_id: true,
        storage_key: true,
        storage_bucket: true,
        candidate: true,
      },
      take: 300,
    });
    for (const r of due) {
      const failed = r.storage_key
        ? await this.deleteObjects([
            { key: r.storage_key, bucket: r.storage_bucket ?? undefined },
          ])
        : new Set<string>();
      const kept = r.storage_key && failed.has(r.storage_key);
      await this.prisma.$transaction([
        this.prisma.cvResumeMessage.deleteMany({ where: { resume_id: r.id } }),
        this.prisma.cvComparisonMessage.deleteMany({
          where: { comparison: { resume_ids: { has: r.id } } },
        }),
        this.prisma.cvScreeningResume.update({
          where: { id: r.id },
          data: {
            ...(kept ? {} : { storage_key: null, storage_bucket: null }),
            cv_text: null,
            application_answers: Prisma.DbNull,
            candidate: withoutContact(r.candidate),
          },
        }),
      ]);
    }

    // A screening is purged once it has expired and none of its CVs keeps a
    // file or a text.
    const purged = await this.prisma.cvScreening.updateMany({
      where: {
        expires_at: { lte: now },
        purged_at: null,
        resumes: {
          none: {
            OR: [{ storage_key: { not: null } }, { cv_text: { not: null } }],
          },
        },
      },
      data: { purged_at: now },
    });
    return { stuck: stuck.length, purged: purged.count };
  }

  /**
   * Deletes CV files; returns the keys it could not delete, which the caller
   * keeps on its row so the next purge tries again — forgotten, a file stayed
   * in the private bucket for good.
   */
  private async deleteObjects(
    objects: { key: string; bucket?: string }[],
  ): Promise<Set<string>> {
    const failed = new Set<string>();
    for (const { key, bucket } of objects) {
      try {
        await this.storage.delete(key, { bucket });
      } catch (err) {
        failed.add(key);
        this.logger.error(
          `Could not delete CV object ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return failed;
  }
}

// ── Views ──────────────────────────────────────────────────────────────

function counts(
  resumes: {
    status: CvScreeningResumeStatus;
    score: number | null;
    candidate: Prisma.JsonValue;
  }[],
) {
  const scored = resumes
    .filter((r) => r.status === CvScreeningResumeStatus.SCORED)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const scores = scored.map((r) => r.score ?? 0);
  const best = scored[0];
  const bestName =
    best?.candidate &&
    typeof best.candidate === 'object' &&
    !Array.isArray(best.candidate) &&
    typeof best.candidate.name === 'string'
      ? best.candidate.name
      : null;
  return {
    total: resumes.length,
    done: resumes.filter((r) => r.status !== CvScreeningResumeStatus.QUEUED)
      .length,
    scored: scored.length,
    bestScore: best ? (best.score ?? 0) : null,
    /** The name the best CV gives, for the list (null when it gives none). */
    bestCandidate: bestName,
    averageScore: scores.length
      ? Math.round(scores.reduce((a, n) => a + n, 0) / scores.length)
      : null,
    /** How the scored CVs spread over the verdicts the pages show. */
    bands: {
      very: scores.filter((n) => n >= 80).length,
      good: scores.filter((n) => n >= 60 && n < 80).length,
      partial: scores.filter((n) => n >= 40 && n < 60).length,
      low: scores.filter((n) => n < 40).length,
    },
  };
}

function screeningSummary(s: ScreeningRow) {
  return {
    id: s.id,
    jobTitle: s.job_title,
    offerId: s.offer_id,
    status: s.status,
    createdAt: s.created_at.toISOString(),
    expiresAt: s.expires_at.toISOString(),
    purged: s.purged_at !== null,
    ...counts(s.resumes),
  };
}

const STATUS_ORDER: Record<CvScreeningResumeStatus, number> = {
  SCORED: 0,
  QUEUED: 1,
  UNREADABLE: 2,
  FAILED: 3,
};

/** A screening with its CVs best first: scored by score, then waiting, then the ones not read. */
export function screeningDetail(s: ScreeningRow) {
  const resumes = [...s.resumes].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (b.score ?? -1) - (a.score ?? -1) ||
      a.created_at.getTime() - b.created_at.getTime(),
  );
  let rank = 0;
  return {
    ...screeningSummary(s),
    jobText: s.job_text,
    resumes: resumes.map((r) => ({
      id: r.id,
      rank: r.status === CvScreeningResumeStatus.SCORED ? ++rank : null,
      fileName: r.file_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      hasFile: r.storage_key !== null,
      status: r.status,
      score: r.score,
      criteria: r.criteria as Record<string, number> | null,
      summary: r.summary,
      strengths: r.strengths,
      gaps: r.gaps,
      candidate: r.candidate as CvCandidate | null,
      error: r.error,
    })),
  };
}

function withoutContact(
  candidate: Prisma.JsonValue,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return Prisma.DbNull;
  }
  return { ...candidate, email: null, phone: null };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === 'string'
          ? part
          : part &&
              typeof part === 'object' &&
              'text' in part &&
              typeof part.text === 'string'
            ? part.text
            : '',
      )
      .join('');
  }
  return '';
}

async function toBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}
