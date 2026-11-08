import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { answerSnippet } from '../cv-screening/lenient-answer';
import { OnEvent } from '@nestjs/event-emitter';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  ApplicationStatus,
  AssignmentStatus,
  CvScreeningResumeStatus,
  ExternalApplicationStatus,
  JobOfferStatus,
  Prisma,
} from '@prisma/client';
import { QueueService } from '../../../common/services/queue/queue.service';
import { CareersService } from '../careers/careers.service';
import { enqueueCvAnalysis, type CvAnalysisJob } from './cv-analysis-jobs';
import {
  MAX_ANALYSIS_ATTEMPTS,
  claimable,
  retryDue,
} from './analysis-attempts';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LlmService } from '../../rag/llm/llm.service';
import {
  BusinessSubscriptionService,
  cvBatchRoom,
} from '../subscription/business-subscription.service';
import { answerText } from '../../job-offer/offer-questions';
import {
  APPLICATION_SUBMITTED,
  type ApplicationSubmitted,
} from '../../application/application.events';
import {
  CvScreeningService,
  type CvUpload,
} from '../cv-screening/cv-screening.service';
import { TEXT_MIME } from '../cv-screening/cv-files';
import { applicantCvText } from './applicant-cv-text';
import {
  applicantMessages,
  applicantScore,
  JSON_REMINDER,
  parseApplicantAssessment,
  reliabilityMark,
  type ApplicantAssessment,
  type ApplicantFacts,
  type OfferFacts,
} from './applicant-assessment';

/** Longest wait for one answer before the next model gets its turn. */
const LLM_TIMEOUT_MS = 45_000;
/** Applications scored per sweep: each is one model call of a few seconds. */
const PER_SWEEP = 20;
/** Older applications are not worth scoring any more. */
const RECENT_DAYS = 120;
const MAX_MISSIONS = 15;
const MAX_PORTFOLIO = 8;
/** How many waiting applications of each source a sweep looks at. */
const CATCH_UP_SCAN = 200;
/** A failed analysis is tried again after this: not at every sweep. */
const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
/** Older applications are not worth a « CV inclus » any more. */
const CATCH_UP_DAYS = 30;
/** A failed score is tried again after this… */
const SCORE_RETRY_MS = 6 * 60 * 60 * 1000;
/** …for this long after its first failure. */
const SCORE_RETRY_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * Ranks the applicants of a business's offers like CV analysis ranks CVs:
 * each application is scored once, in the background, from the applicant's
 * profile against the offer. Included in every plan.
 */
@Injectable()
export class ApplicantScoreService {
  private readonly logger = new Logger(ApplicantScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly screenings: CvScreeningService,
    private readonly queue: QueueService,
    private readonly careers: CareersService,
  ) {}

  /** Scores the applications that have none yet; returns how many were scored. */
  async sweep(now = new Date()): Promise<number> {
    const pending = await this.prisma.application.findMany({
      where: {
        // Never scored, or a failed try old enough to try again: every 6 h,
        // for a day after the first one (it used to retry the same batch
        // every 2 minutes, and the older ones waited behind it).
        OR: [
          { assessment: null },
          {
            assessment: {
              failed: true,
              updated_at: { lte: new Date(now.getTime() - SCORE_RETRY_MS) },
              created_at: {
                gte: new Date(now.getTime() - SCORE_RETRY_FOR_MS),
              },
            },
          },
        ],
        // A refused or cancelled application needs no score.
        status: {
          notIn: [ApplicationStatus.CANCELLED, ApplicationStatus.REJECTED],
        },
        created_at: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) },
        job_offer: {
          deleted_at: null,
          // Only for a business with a plan running: a model call each.
          employer: {
            is_business: true,
            business: {
              subscriptions: {
                some: {
                  status: { in: ['TRIAL', 'ACTIVE'] },
                  starts_at: { lte: now },
                  ends_at: { gt: now },
                },
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: PER_SWEEP,
      select: { id: true },
    });
    let done = 0;
    for (const { id } of pending) {
      if (await this.assess(id)) done++;
    }
    return done;
  }

  /**
   * What the scoring and the applicant's CV text both read: the offer, and the
   * candidate as Rabotka knows them (trades, missions, publications, answers,
   * and the text of « Mon CV » when they sent it, contacts removed).
   */
  async facts(applicationId: string) {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { category: { select: { name: true } } } },
        answers: {
          select: { label: true, kind: true, value: true, passed: true },
          orderBy: { created_at: 'asc' },
        },
        profile_cv: { select: { cv_text: true } },
        worker: {
          include: {
            category: { select: { name: true } },
            categories: {
              include: { category: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!app) return null;
    const [missions, portfolio] = await Promise.all([
      this.prisma.assignment.findMany({
        where: { worker_id: app.worker_id, status: AssignmentStatus.COMPLETED },
        orderBy: { completed_at: 'desc' },
        take: MAX_MISSIONS,
        select: {
          completed_at: true,
          job_offer: {
            select: { title: true, category: { select: { name: true } } },
          },
        },
      }),
      this.prisma.portfolioItem.findMany({
        where: { profile_id: app.worker_id, description: { not: null } },
        orderBy: { position: 'asc' },
        take: MAX_PORTFOLIO,
        select: { description: true },
      }),
    ]);
    const w = app.worker;
    const trades = [
      ...new Set(
        [w.category?.name, ...w.categories.map((c) => c.category.name)].filter(
          (t): t is string => !!t,
        ),
      ),
    ];
    const o = app.job_offer;
    const offer: OfferFacts = {
      title: o.title,
      description: o.description,
      trade: o.category?.name ?? null,
      city: o.city,
      country: o.country_name,
      isRemote: o.is_remote,
      note: o.note,
    };
    const applicant: ApplicantFacts = {
      trades,
      description: w.description,
      city: w.city,
      country: w.country_name ?? null,
      memberSince: w.created_at,
      reliabilityScore: w.reliability_score,
      ratingAvg: w.rating_avg,
      ratingCount: w.rating_count,
      missions: missions.map((m) => ({
        title: m.job_offer.title,
        trade: m.job_offer.category?.name ?? null,
        completedAt: m.completed_at,
      })),
      portfolio: portfolio.map((p) => (p.description ?? '').slice(0, 200)),
      answers: (app.answers ?? []).map((x) => ({
        question: x.label,
        answer: answerText(x),
        knockoutFailed: x.passed === false,
      })),
      cvText: app.profile_cv?.cv_text || undefined,
    };
    return { app, offer, applicant };
  }

  /** One application; false when the provider failed (tried again next sweep). */
  async assess(applicationId: string): Promise<boolean> {
    const loaded = await this.facts(applicationId);
    if (!loaded) return false;
    const { offer, applicant } = loaded;
    const w = loaded.app.worker;
    const messages = applicantMessages(offer, applicant);

    let read: ApplicantAssessment | null;
    try {
      read = await this.ask(messages, applicationId);
    } catch (err) {
      this.logger.warn(
        `Applicant score failed for ${applicationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Recorded, so the next sweep takes the others first; tried again later.
      await this.prisma.applicationAssessment
        .upsert({
          where: { application_id: applicationId },
          create: { application_id: applicationId, failed: true },
          update: { failed: true },
        })
        .catch(() => undefined);
      return false;
    }

    const reliability = reliabilityMark({
      reliabilityScore: w.reliability_score,
      ratingAvg: w.rating_avg,
      ratingCount: w.rating_count,
    });
    const criteria = read
      ? { ...read.criteria, ...(reliability !== null ? { reliability } : {}) }
      : null;
    const data = read
      ? {
          score: applicantScore(criteria!),
          criteria: criteria as Prisma.InputJsonValue,
          summary: read.summary,
          strengths: read.strengths,
          gaps: read.gaps,
          failed: false,
        }
      : { failed: true };
    await this.prisma.applicationAssessment.upsert({
      where: { application_id: applicationId },
      create: { application_id: applicationId, ...data },
      update: data,
    });
    return true;
  }

  /**
   * The waiting applications to business offers that have no CV analysis: those
   * that came while the plan had no « CV inclus », before analysis on arrival,
   * or whose analysis failed a while ago. Only for businesses that can pay for
   * them now, and never more than they can: one business out of « CV inclus »
   * never holds up the others. Queued (deduplicated by application), not run
   * here; returns how many were queued.
   */
  async queueWaitingAnalyses(now = new Date()): Promise<number> {
    const since = new Date(now.getTime() - CATCH_UP_DAYS * 86_400_000);
    const failedBefore = new Date(now.getTime() - FAILED_RETRY_MS);
    const recruiting = {
      deleted_at: null,
      status: { in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED] },
      employer: { is_business: true },
    };
    const [rabotka, careers] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          OR: [
            { cv_resume_id: null },
            {
              cv_resume: {
                status: CvScreeningResumeStatus.FAILED,
                updated_at: { lte: failedBefore },
              },
              analysis_attempts: { lt: MAX_ANALYSIS_ATTEMPTS },
            },
          ],
          deleted_at: null,
          status: { in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED] },
          created_at: { gte: since },
          job_offer: recruiting,
        },
        orderBy: { created_at: 'desc' },
        take: CATCH_UP_SCAN,
        select: {
          id: true,
          job_offer_id: true,
          job_offer: { select: { employer_id: true } },
          analysis_attempts: true,
          cv_resume: { select: { updated_at: true } },
        },
      }),
      // A careers CV that failed is tried again like a Rabotka one (it
      // never was): it was given back, and is still waiting for a score.
      this.prisma.externalApplication.findMany({
        where: {
          OR: [
            { cv_resume_id: null },
            {
              cv_resume: {
                status: CvScreeningResumeStatus.FAILED,
                updated_at: { lte: failedBefore },
              },
              analysis_attempts: { lt: MAX_ANALYSIS_ATTEMPTS },
            },
          ],
          cv_storage_key: { not: null },
          status: ExternalApplicationStatus.PENDING,
          created_at: { gte: since },
          job_offer: recruiting,
        },
        orderBy: { created_at: 'desc' },
        take: CATCH_UP_SCAN,
        select: {
          id: true,
          job_offer_id: true,
          job_offer: { select: { employer_id: true } },
          analysis_attempts: true,
          cv_size_bytes: true,
          cv_resume: { select: { updated_at: true } },
        },
      }),
    ]);
    // A failed one waits longer after each try (6 h, 12 h), and stops at the
    // maximum: each try is a model call, charged then given back.
    const due = (a: {
      analysis_attempts: number;
      cv_resume: { updated_at: Date } | null;
    }) =>
      !a.cv_resume ||
      retryDue(a.analysis_attempts, a.cv_resume.updated_at, now);

    // By business, newest first, so the « CV inclus » left go to who just applied.
    const byEmployer = new Map<string, CvAnalysisJob[]>();
    const push = (job: CvAnalysisJob) => {
      const list = byEmployer.get(job.employerId) ?? [];
      list.push(job);
      byEmployer.set(job.employerId, list);
    };
    for (const a of rabotka.filter(due)) {
      push({
        kind: 'rabotka',
        applicationId: a.id,
        offerId: a.job_offer_id,
        employerId: a.job_offer.employer_id,
      });
    }
    // A CV above the plan's file size is never sent (it would be refused
    // every 2 minutes, taking another CV's turn): the business sees it unread.
    const sizes = new Map(careers.map((a) => [a.id, a.cv_size_bytes]));
    for (const a of careers.filter(due)) {
      push({
        kind: 'careers',
        applicationId: a.id,
        offerId: a.job_offer_id,
        employerId: a.job_offer.employer_id,
      });
    }

    let queued = 0;
    for (const [employerId, jobs] of byEmployer) {
      const businessId = await this.subscriptions.businessOf(employerId);
      if (!businessId) continue;
      const e = await this.subscriptions.entitlements(businessId);
      const maxBytes = e.cvFileMaxMb * 1024 * 1024;
      const sendable = jobs.filter(
        (j) =>
          j.kind !== 'careers' || (sizes.get(j.applicationId) ?? 0) <= maxBytes,
      );
      // One « CV inclus » each: as many as are left (all, on an unlimited plan).
      const room = e.cvQuota === 0 ? 0 : (e.cvRemaining ?? sendable.length);
      for (const job of sendable.slice(0, room)) {
        await enqueueCvAnalysis(this.queue, job);
        queued++;
      }
    }
    return queued;
  }

  /**
   * A Rabotka application to a business offer is queued for analysis as it
   * arrives, like a careers-page CV: on the plan's « CV inclus », so every
   * candidate can be compared at once.
   */
  @OnEvent(APPLICATION_SUBMITTED, { async: true })
  async analyseOnArrival({
    applicationId,
    jobOfferId,
    employerId,
  }: ApplicationSubmitted): Promise<void> {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { is_business: true },
    });
    if (!employer?.is_business) return;
    await enqueueCvAnalysis(this.queue, {
      kind: 'rabotka',
      applicationId,
      offerId: jobOfferId,
      employerId,
    }).catch((err) =>
      this.logger.warn(
        `CV analysis of application ${applicationId} not queued: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  /**
   * One queued analysis. What the business cannot have — no « CV inclus »
   * left, the offer closed, the application already read — ends the job: it is
   * queued again once that changes. Anything else (the network, the storage)
   * throws, and the queue tries again.
   */
  async runAnalysisJob(job: CvAnalysisJob, now = new Date()): Promise<void> {
    try {
      if (job.kind === 'rabotka') {
        await this.analyse(
          job.employerId,
          job.offerId,
          job.applicationId,
          undefined,
          new Date(now.getTime() - FAILED_RETRY_MS),
        );
      } else {
        await this.careers.analyse(
          job.employerId,
          job.offerId,
          job.applicationId,
          new Date(now.getTime() - FAILED_RETRY_MS),
        );
      }
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() < 500) {
        this.logger.debug(
          `CV analysis of ${job.kind} ${job.applicationId} not run: ${err.message}`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Runs CV analysis on Rabotka applicants: one, or those of the offer not yet
   * read, up to what the plan takes at once. Each uses one « CV inclus », and
   * joins the offer's screening beside the careers-page CVs, so it can be asked
   * about and compared. What is read is `applicantCvText`, never a file with
   * the contacts on it.
   */
  async analyse(
    profileId: string,
    offerId: string,
    applicationId?: string,
    /** Only those that applied before: leaves the newest to analysis on arrival. */
    appliedBefore?: Date,
    /** Also those whose analysis failed before then: tried again, not forever. */
    retryFailedBefore?: Date,
  ) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const e = await this.subscriptions.entitlements(businessId);
    const room = cvBatchRoom(e);
    if (room === 0) {
      throw new ForbiddenException(
        'Vous avez utilisé tous les CV inclus dans votre formule pour cette période. Changez de formule pour en analyser davantage.',
      );
    }
    const where: Prisma.ApplicationWhereInput = {
      job_offer_id: offerId,
      // Only while the offer recruits, as for a careers-page CV.
      job_offer: {
        employer_id: profileId,
        deleted_at: null,
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
      },
      deleted_at: null,
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
      status: applicationId
        ? { notIn: [ApplicationStatus.CANCELLED, ApplicationStatus.REJECTED] }
        : { in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED] },
      ...(applicationId ? { id: applicationId } : {}),
      ...(appliedBefore ? { created_at: { lte: appliedBefore } } : {}),
    };
    const now = new Date();
    const [found, total] = await Promise.all([
      this.prisma.application.findMany({
        where: { ...where, AND: [claimable(now)] },
        orderBy: { created_at: 'desc' },
        take: room,
        select: { id: true, cv_resume_id: true },
      }),
      this.prisma.application.count({ where }),
    ]);
    // Claimed before anything is charged: « Analyser tout » and a queued job
    // running together would each have charged (and analysed) the same CV.
    const ids = found.map((a) => a.id);
    if (ids.length > 0) {
      await this.prisma.application.updateMany({
        where: { id: { in: ids }, AND: [claimable(now)] },
        data: { analysis_claimed_at: now },
      });
    }
    const mine = new Set(
      ids.length === 0
        ? []
        : (
            await this.prisma.application.findMany({
              where: { id: { in: ids }, analysis_claimed_at: now },
              select: { id: true },
            })
          ).map((a) => a.id),
    );
    const due = found.filter((a) => mine.has(a.id));
    if (due.length === 0) {
      throw new BadRequestException('Aucun candidat à analyser.');
    }
    const release = () =>
      this.prisma.application.updateMany({
        where: { id: { in: [...mine] }, analysis_claimed_at: now },
        data: { analysis_claimed_at: null },
      });

    try {
      return await this.analyseClaimed(profileId, offerId, due, total);
    } finally {
      // Linked ones no longer need it; the others are free for a next try.
      await release().catch(() => undefined);
    }
  }

  /** The CVs of applications this run holds the claim on: sent, then linked. */
  private async analyseClaimed(
    profileId: string,
    offerId: string,
    due: { id: string; cv_resume_id: string | null }[],
    total: number,
  ) {
    const files: (CvUpload & { tag: string })[] = [];
    for (const { id } of due) {
      const loaded = await this.facts(id);
      if (!loaded) continue;
      const w = loaded.app.worker;
      const name = `${w.first_name} ${w.last_name}`.trim() || 'Candidat';
      const buffer = Buffer.from(
        applicantCvText(name, loaded.applicant),
        'utf8',
      );
      files.push({
        originalname: `${name} ${id}.txt`,
        mimetype: TEXT_MIME,
        internalType: TEXT_MIME,
        size: buffer.length,
        buffer,
        tag: id,
        // Beside the CV, not inside it: the analysis reads them as answers.
        answers: loaded.applicant.answers,
      });
    }

    const screening = await this.screenings.addToOffer(
      profileId,
      offerId,
      files,
    );
    for (const { id, cv_resume_id: failed } of due) {
      const resumeId = screening.resumeIds.get(id);
      if (!resumeId) continue;
      await this.prisma.application.update({
        where: { id },
        data: { cv_resume_id: resumeId, analysis_attempts: { increment: 1 } },
      });
      // The failed try it replaces: gone, rather than a dead row in the screening.
      if (failed) {
        await this.prisma.cvScreeningResume
          .delete({ where: { id: failed } })
          .catch(() => undefined);
      }
    }
    return {
      screeningId: screening.screeningId,
      analysed: files.length,
      left: total - due.length,
    };
  }

  /** The scores of an offer's applicants, for the business that owns it. */
  async forOffer(profileId: string, offerId: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: { id: true },
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    const apps = await this.prisma.application.findMany({
      where: { job_offer_id: offer.id },
      select: { id: true, assessment: true },
    });
    return {
      assessments: apps
        .filter((a) => a.assessment && !a.assessment.failed)
        .map((a) => ({
          applicationId: a.id,
          score: a.assessment!.score,
          criteria: a.assessment!.criteria,
          summary: a.assessment!.summary,
          strengths: a.assessment!.strengths,
          gaps: a.assessment!.gaps,
        })),
      /** Applications still waiting for their score (a sweep runs every 2 minutes). */
      pending: apps.filter((a) => !a.assessment).length,
    };
  }

  private async ask(
    messages: ReturnType<typeof applicantMessages>,
    applicationId: string,
  ): Promise<ApplicantAssessment | null> {
    const options = {
      tier: 'document' as const,
      timeoutMs: LLM_TIMEOUT_MS,
      correlationId: `applicant-score:${applicationId}`,
    };
    const first = text(
      (await this.llm.invoke(messages, options)).output.content,
    );
    const parsed = parseApplicantAssessment(first);
    if (parsed) return parsed;
    const second = text(
      (
        await this.llm.invoke(
          [...messages, new AIMessage(first), new HumanMessage(JSON_REMINDER)],
          options,
        )
      ).output.content,
    );
    const read = parseApplicantAssessment(second);
    if (!read) {
      this.logger.warn(
        `Applicant score unreadable for ${applicationId}: ${answerSnippet(second)}`,
      );
    }
    return read;
  }
}

function text(content: unknown): string {
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
