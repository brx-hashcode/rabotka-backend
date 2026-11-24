import { Injectable, Logger } from '@nestjs/common';
import {
  ApplicationStatus,
  CvScreeningResumeStatus,
  JobOfferStatus,
  type CvScreeningResume,
  type OfferQuestionKind,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AnswerFilesService } from '../../answer-files/answer-files.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { applicantCvText } from '../applicant-score/applicant-cv-text';
import { applicantFacts } from '../applicant-score/applicant-facts';
import { addMonthsClamped } from '../subscription/subscription-rules';
import type { ApplicationAnswerNote } from './cv-assessment';
import { CvScreeningService } from './cv-screening.service';

/**
 * Whether a CV can be asked about: `ready` (it is there), `restorable` (its
 * text can be rebuilt), or why not: deleted by the business, gone at the end
 * of its time, or a scan nobody could read.
 */
export type CvAvailability =
  'ready' | 'restorable' | 'removed' | 'expired' | 'unreadable';

type Resume = Pick<
  CvScreeningResume,
  | 'id'
  | 'screening_id'
  | 'status'
  | 'storage_key'
  | 'cv_text'
  | 'removed_at'
  | 'expires_at'
  | 'created_at'
>;

type Source =
  | { kind: 'rabotka'; applicationId: string; until: Date }
  | {
      kind: 'careers';
      key: string;
      bucket: string | null;
      mimeType: string;
      answers: Prisma.JsonValue;
      until: Date;
    };

const OPEN: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

const OFFER = { select: { status: true, deleted_at: true } } as const;

/**
 * CVs purged before they were kept until the business deletes them: their
 * text is rebuilt when someone asks about them, without a new analysis nor a
 * « CV inclus ». A Rabotka applicant's from their profile and answers, a
 * careers-page or imported one from its original file. Never one the business
 * deleted, nor a candidate who withdrew or closed their account.
 */
@Injectable()
export class CvRestoreService {
  private readonly logger = new Logger(CvRestoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly screenings: CvScreeningService,
    private readonly answerFiles: AnswerFilesService,
  ) {}

  /** Each CV's availability, by id. */
  async availability(
    resumes: readonly Resume[],
  ): Promise<Map<string, CvAvailability>> {
    const out = new Map<string, CvAvailability>();
    const gone: Resume[] = [];
    for (const r of resumes) {
      if (r.removed_at) out.set(r.id, 'removed');
      else if (r.cv_text === '') out.set(r.id, 'unreadable');
      else if (r.cv_text || r.storage_key) out.set(r.id, 'ready');
      else gone.push(r);
    }
    const sources = await this.sources(gone);
    for (const r of gone) {
      out.set(r.id, sources.has(r.id) ? 'restorable' : 'expired');
    }
    return out;
  }

  /** A purged CV's text, rebuilt and kept; null when nothing is left of it. */
  async restore(resume: Resume): Promise<string | null> {
    if (resume.removed_at) return null;
    const source = (await this.sources([resume])).get(resume.id);
    if (!source) return null;
    let rebuilt: { text: string | null; answers: ApplicationAnswerNote[] };
    try {
      rebuilt =
        source.kind === 'rabotka'
          ? await this.fromProfile(source.applicationId)
          : await this.fromOriginal(resume, source);
    } catch (err) {
      this.logger.warn(
        `CV ${resume.id} could not be rebuilt: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!rebuilt.text) return null;
    // Not if the business deleted it meanwhile.
    const { count } = await this.prisma.cvScreeningResume.updateMany({
      where: { id: resume.id, removed_at: null },
      data: {
        cv_text: rebuilt.text,
        expires_at: source.until,
        ...(rebuilt.answers.length
          ? { application_answers: rebuilt.answers }
          : {}),
      },
    });
    if (count === 0) return null;
    await this.prisma.cvScreening.updateMany({
      where: { id: resume.screening_id, expires_at: { lt: source.until } },
      data: { expires_at: source.until },
    });
    await this.prisma.cvScreening.updateMany({
      where: { id: resume.screening_id, purged_at: { not: null } },
      data: { purged_at: null },
    });
    return rebuilt.text;
  }

  private async fromProfile(applicationId: string) {
    const loaded = await applicantFacts(
      this.prisma,
      this.answerFiles,
      applicationId,
    );
    if (!loaded) return { text: null, answers: [] };
    const w = loaded.app.worker;
    const name = `${w.first_name} ${w.last_name}`.trim() || 'Candidat';
    return {
      text: applicantCvText(name, loaded.applicant),
      answers: loaded.applicant.answers ?? [],
    };
  }

  private async fromOriginal(
    resume: Resume,
    source: Extract<Source, { kind: 'careers' }>,
  ) {
    const read = await this.screenings.sourceOf({
      storage_key: source.key,
      storage_bucket: source.bucket,
      mime_type: source.mimeType,
    });
    return {
      text: read ? await this.screenings.transcribe(read, resume.id) : null,
      answers: await this.answerFiles.notes(
        Array.isArray(source.answers)
          ? (source.answers as {
              label: string;
              kind: OfferQuestionKind;
              value: string;
              passed?: boolean | null;
            }[])
          : [],
      ),
    };
  }

  /** What each purged CV can be rebuilt from, when it may be. */
  private async sources(
    resumes: readonly Resume[],
  ): Promise<Map<string, Source>> {
    const out = new Map<string, Source>();
    const scored = resumes.filter(
      (r) => r.status === CvScreeningResumeStatus.SCORED,
    );
    if (scored.length === 0) return out;
    const ids = scored.map((r) => r.id);
    const [applications, externals, months] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          cv_resume_id: { in: ids },
          deleted_at: null,
          cv_removed_at: null,
          status: { not: ApplicationStatus.CANCELLED },
          worker: { deleted_at: null },
        },
        select: { id: true, cv_resume_id: true, job_offer: OFFER },
      }),
      this.prisma.externalApplication.findMany({
        where: {
          cv_resume_id: { in: ids },
          cv_storage_key: { not: null },
          cv_removed_at: null,
        },
        select: {
          cv_resume_id: true,
          cv_storage_key: true,
          cv_storage_bucket: true,
          cv_mime_type: true,
          answers: true,
          pool_withdrawn_at: true,
          job_offer: OFFER,
        },
      }),
      this.systemConfig.getCvLimitMonths(),
    ]);
    const now = new Date();
    const byId = new Map(scored.map((r) => [r.id, r]));
    const recruits = (o: { status: JobOfferStatus; deleted_at: Date | null }) =>
      !o.deleted_at && OPEN.includes(o.status);
    /** How long it may be kept; null when its time is over. */
    const until = (r: Resume, recruiting: boolean): Date | null => {
      if (recruiting) return addMonthsClamped(now, months);
      const limit = addMonthsClamped(r.created_at, months);
      const end = r.expires_at && r.expires_at > limit ? r.expires_at : limit;
      return end > now ? end : null;
    };

    for (const a of applications) {
      const r = byId.get(a.cv_resume_id as string);
      const end = r && until(r, recruits(a.job_offer));
      if (end)
        out.set(r.id, { kind: 'rabotka', applicationId: a.id, until: end });
    }
    for (const a of externals) {
      const r = byId.get(a.cv_resume_id as string);
      const recruiting = recruits(a.job_offer);
      // Took their consent back: only while that offer recruits.
      if (!r || (a.pool_withdrawn_at && !recruiting)) continue;
      const end = until(r, recruiting);
      if (!end) continue;
      out.set(r.id, {
        kind: 'careers',
        key: a.cv_storage_key as string,
        bucket: a.cv_storage_bucket,
        mimeType: a.cv_mime_type,
        answers: a.answers,
        until: end,
      });
    }
    return out;
  }
}
