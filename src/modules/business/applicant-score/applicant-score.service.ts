import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import {
  ApplicationStatus,
  AssignmentStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LlmService } from '../../rag/llm/llm.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  applicantMessages,
  applicantScore,
  JSON_REMINDER,
  parseApplicantAssessment,
  reliabilityMark,
  type ApplicantAssessment,
} from './applicant-assessment';

/** Longest wait for one answer before the next model gets its turn. */
const LLM_TIMEOUT_MS = 45_000;
/** Applications scored per sweep: each is one model call of a few seconds. */
const PER_SWEEP = 20;
/** Older applications are not worth scoring any more. */
const RECENT_DAYS = 120;
const MAX_MISSIONS = 15;
const MAX_PORTFOLIO = 8;

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

  /** One application; false when the provider failed (tried again next sweep). */
  async assess(applicationId: string): Promise<boolean> {
    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { category: { select: { name: true } } } },
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
    if (!app) return false;
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
    const messages = applicantMessages(
      {
        title: o.title,
        description: o.description,
        trade: o.category?.name ?? null,
        city: o.city,
        country: o.country_name,
        isRemote: o.is_remote,
        note: o.note,
      },
      {
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
      },
    );

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
