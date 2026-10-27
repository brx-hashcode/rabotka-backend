import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
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
  type CvAssessment,
  type CvCandidate,
  type CvSource,
} from './cv-assessment';
import {
  CV_SCREENING_PROGRESS,
  type CvScreeningProgress,
} from './cv-screening.events';

export type CvScreeningJob = { resumeId: string };

/** One uploaded file, as multer hands it over. */
export type CvUpload = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
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
  ) {
    const businessId = await this.requireBusiness(profileId);
    const e = await this.subscriptions.entitlements(businessId);
    if (e.cvQuota === 0) {
      throw new ForbiddenException(
        'L’analyse de CV est incluse dans les formules supérieures. Changez de formule depuis votre espace, rubrique « Abonnement ».',
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
      const type = cvFileType(file.buffer, file.mimetype);
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

    const plan = await this.prisma.businessSubscription.findUnique({
      where: { id: subscriptionId },
      select: { plan: { select: { cv_retention_days: true } } },
    });
    const retentionDays = plan?.plan.cv_retention_days ?? 30;

    const screening = await this.prisma.cvScreening.create({
      data: {
        id,
        business_id: businessId,
        subscription_id: subscriptionId,
        offer_id: brief.offerId,
        job_title: brief.title,
        job_text: brief.text,
        expires_at: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
        resumes: {
          create: typed.map(({ file, type, name }, i) => ({
            file_name: name.slice(0, 200),
            mime_type: type,
            size_bytes: file.size,
            storage_key: uploaded[i].key,
            storage_bucket: uploaded[i].bucket,
          })),
        },
      },
      include: { resumes: true },
    });

    for (const resume of screening.resumes) {
      await this.queue.addJob<CvScreeningJob>(CV_SCREENING_QUEUE, {
        resumeId: resume.id,
      });
    }
    return screeningDetail(screening);
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
    return screeningDetail(await this.owned(profileId, id));
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
    await this.deleteObjects(
      screening.resumes.flatMap((r) =>
        r.storage_key
          ? [{ key: r.storage_key, bucket: r.storage_bucket ?? undefined }]
          : [],
      ),
    );
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
    if (outcome.status !== 'SCORED' && resume.screening.subscription_id) {
      await this.subscriptions.releaseCv(resume.screening.subscription_id, 1);
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
  ): Promise<CvAssessment | null> {
    const messages: BaseMessage[] = assessmentMessages(job, source);
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
    return parseAssessment(second);
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
      WHERE status = 'SCORED' AND cv_text IS NOT NULL
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

    const expired = await this.prisma.cvScreening.findMany({
      where: { expires_at: { lte: now }, purged_at: null },
      include: { resumes: true },
      take: 100,
    });
    for (const screening of expired) {
      await this.deleteObjects(
        screening.resumes.flatMap((r) =>
          r.storage_key
            ? [{ key: r.storage_key, bucket: r.storage_bucket ?? undefined }]
            : [],
        ),
      );
      await this.prisma.$transaction([
        // The conversations quote the CV: they go with it.
        this.prisma.cvResumeMessage.deleteMany({
          where: { resume_id: { in: screening.resumes.map((r) => r.id) } },
        }),
        this.prisma.cvComparisonMessage.deleteMany({
          where: { comparison: { screening_id: screening.id } },
        }),
        ...screening.resumes.map((r) =>
          this.prisma.cvScreeningResume.update({
            where: { id: r.id },
            data: {
              storage_key: null,
              storage_bucket: null,
              cv_text: null,
              candidate: withoutContact(r.candidate),
            },
          }),
        ),
        this.prisma.cvScreening.update({
          where: { id: screening.id },
          data: { purged_at: now },
        }),
      ]);
    }
    return { stuck: stuck.length, purged: expired.length };
  }

  private async deleteObjects(
    objects: { key: string; bucket?: string }[],
  ): Promise<void> {
    for (const { key, bucket } of objects) {
      await this.storage
        .delete(key, { bucket })
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not delete CV object ${key}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
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
