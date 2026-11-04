import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  ApplicationStatus,
  AssignmentStatus,
  JobOfferStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LlmService } from '../../rag/llm/llm.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
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
/** Offers whose waiting applicants get their CV analysed, per sweep. */
const CATCH_UP_OFFERS = 5;
/** Left to the analysis on arrival before the sweep takes over. */
const ARRIVAL_GRACE_MS = 5 * 60 * 1000;

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
  ) {}

  /** Scores the applications that have none yet; returns how many were scored. */
  async sweep(now = new Date()): Promise<number> {
    const pending = await this.prisma.application.findMany({
      where: {
        assessment: null,
        status: { not: ApplicationStatus.CANCELLED },
        created_at: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) },
        job_offer: { deleted_at: null, employer: { is_business: true } },
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
          select: { label: true, kind: true, value: true },
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
   * The waiting Rabotka applications to business offers that have no CV
   * analysis yet: those that came before analysis on arrival, or that found the
   * plan with no « CV inclus » left. A few offers per sweep, each analysed as
   * « Analyser tout » would. Never one that just arrived: analysis on arrival
   * may still be running for it, and the same CV must not be paid twice.
   */
  async catchUpAnalyses(now = new Date()): Promise<number> {
    const waiting = await this.prisma.application.findMany({
      where: {
        cv_resume_id: null,
        deleted_at: null,
        status: { in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED] },
        created_at: {
          gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000),
          lte: new Date(now.getTime() - ARRIVAL_GRACE_MS),
        },
        job_offer: {
          deleted_at: null,
          status: {
            in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
          },
          employer: { is_business: true },
        },
      },
      distinct: ['job_offer_id'],
      take: CATCH_UP_OFFERS,
      select: {
        job_offer_id: true,
        job_offer: { select: { employer_id: true } },
      },
    });
    let analysed = 0;
    for (const w of waiting) {
      try {
        analysed += (
          await this.analyse(
            w.job_offer.employer_id,
            w.job_offer_id,
            undefined,
            new Date(now.getTime() - ARRIVAL_GRACE_MS),
          )
        ).analysed;
      } catch (err) {
        // A plan without « CV inclus » left: tried again on a later sweep.
        this.logger.debug(
          `CV analysis catch-up skipped for offer ${w.job_offer_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return analysed;
  }

  /**
   * A Rabotka application to a business offer is analysed as it arrives, like a
   * careers-page CV: on the plan's « CV inclus », so every candidate can be
   * compared at once. A plan with none left simply leaves it to analyse later.
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
    try {
      await this.analyse(employerId, jobOfferId, applicationId);
    } catch (err) {
      this.logger.warn(
        `Automatic CV analysis of application ${applicationId} skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
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
  ) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const e = await this.subscriptions.entitlements(businessId);
    const where: Prisma.ApplicationWhereInput = {
      job_offer_id: offerId,
      job_offer: { employer_id: profileId, deleted_at: null },
      deleted_at: null,
      cv_resume_id: null,
      status: applicationId
        ? { notIn: [ApplicationStatus.CANCELLED, ApplicationStatus.REJECTED] }
        : { in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED] },
      ...(applicationId ? { id: applicationId } : {}),
      ...(appliedBefore ? { created_at: { lte: appliedBefore } } : {}),
    };
    const [due, total] = await Promise.all([
      this.prisma.application.findMany({
        where,
        orderBy: { created_at: 'asc' },
        take: e.cvBatchMax,
        select: { id: true },
      }),
      this.prisma.application.count({ where }),
    ]);
    if (due.length === 0) {
      throw new BadRequestException('Aucun candidat à analyser.');
    }

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
      });
    }

    const screening = await this.screenings.addToOffer(
      profileId,
      offerId,
      files,
    );
    for (const { id } of due) {
      const resumeId = screening.resumeIds.get(id);
      if (!resumeId) continue;
      await this.prisma.application.update({
        where: { id },
        data: { cv_resume_id: resumeId },
      });
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
    return parseApplicantAssessment(second);
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
