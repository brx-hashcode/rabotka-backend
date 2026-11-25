import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { CvScreeningResumeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { LlmService } from '../../rag/llm/llm.service';
import { cvScoringModel, parseSpec } from '../../rag/llm/models.config';
import { SystemConfigService } from '../../system-config/system-config.service';
import { writtenIn } from '../output-language';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { JSON_REMINDER } from './cv-assessment';
import {
  defaultGrid,
  GridError,
  isFit,
  isMust,
  needsReading,
  normaliseGrid,
  parseProposal,
  proposalMessages,
  type GridInput,
  type GridItem,
} from './cv-grid';
import { evaluate, readStored } from './cv-marking';
import { answerSnippet } from './lenient-answer';
import { offerBrief, OFFER_BRIEF } from './offer-brief';
import { explainGap, points } from './scoring';

const LLM_TIMEOUT_MS = 45_000;

/** Whose grid: an offer's or, for an analysis opened without one, its own. */
export type GridOwner =
  { offerId: string } | { screeningId: string; offerId?: undefined };

export type Grid = {
  id: string;
  version: number;
  items: GridItem[];
  jobHash: string;
  source: string;
  /** The only one that marks its candidates. */
  model: string | null;
};

export type Job = { title: string; text: string; remote: boolean };

/** Whose grid it is, and the job it is made for. */
export type GridOf = { businessId: string; owner: GridOwner; job: Job };

type Db = Prisma.TransactionClient | PrismaService;

export const jobHash = (job: { title: string; text: string }) =>
  createHash('sha256').update(`${job.title}\n${job.text}`).digest('hex');

const ownerWhere = (owner: GridOwner) =>
  owner.offerId !== undefined
    ? { offer_id: owner.offerId }
    : { screening_id: owner.screeningId };

const toGrid = (row: {
  id: string;
  version: number;
  items: Prisma.JsonValue;
  job_hash: string;
  source: string;
  model: string | null;
}): Grid => ({
  id: row.id,
  version: row.version,
  items: row.items as unknown as GridItem[],
  jobHash: row.job_hash,
  source: row.source,
  model: row.model,
});

/**
 * The grids: proposed once per offer, edited by the business, one new version
 * per change. An offer that already has scores keeps the previous formula,
 * for its new candidates too, until the business asks for it
 * (`CvRescoreService`): two formulas are never ranked in one list.
 */
@Injectable()
export class CvGridService {
  private readonly logger = new Logger(CvGridService.name);
  /** Proposals on their way, so an offer's first CVs share one. */
  private readonly making = new Map<string, Promise<Grid | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /** The grid in use; null on the previous formula, or before the first CV. */
  async current(owner: GridOwner, db: Db = this.prisma): Promise<Grid | null> {
    const row = await db.cvGrid.findFirst({
      where: ownerWhere(owner),
      orderBy: { version: 'desc' },
    });
    return row && toGrid(row);
  }

  /** The grid to mark a CV on, proposed if there is none; null: previous formula. */
  async forJob(
    businessId: string,
    owner: GridOwner,
    job: Job,
  ): Promise<Grid | null> {
    const existing = await this.current(owner);
    if (existing) return existing;
    // Switched off: the previous formula, but for offers already on a grid.
    if (!(await this.systemConfig.getCvGridScoring())) return null;
    const key = JSON.stringify(owner);
    const running = this.making.get(key);
    if (running) return running;
    const made = (async () => {
      if (await this.hasPreviousScores(owner)) return null;
      return this.create(businessId, owner, job);
    })().finally(() => this.making.delete(key));
    this.making.set(key, made);
    return made;
  }

  /** Version 1, from the model or the default one. */
  async create(businessId: string, owner: GridOwner, job: Job): Promise<Grid> {
    const proposed = await this.ask(job).catch((err: unknown) => {
      this.logger.warn(
        `No grid proposed for ${JSON.stringify(owner)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    });
    try {
      return toGrid(
        await this.prisma.cvGrid.create({
          data: {
            business_id: businessId,
            ...ownerWhere(owner),
            version: 1,
            items: (proposed ??
              defaultGrid(
                writtenIn(`${job.title}\n${job.text}`) === 'en' ? 'en' : 'fr',
              )) as unknown as Prisma.InputJsonValue,
            job_hash: jobHash(job),
            source: proposed ? 'PROPOSED' : 'DEFAULT',
            model: cvScoringModel(),
          },
        }),
      );
    } catch (err) {
      // Another process made it first.
      const other = await this.current(owner);
      if (other) return other;
      throw err;
    }
  }

  private async hasPreviousScores(owner: GridOwner): Promise<boolean> {
    const screening =
      owner.offerId !== undefined
        ? { offer_id: owner.offerId }
        : { id: owner.screeningId };
    const cv = await this.prisma.cvScreeningResume.findFirst({
      where: {
        screening,
        status: CvScreeningResumeStatus.SCORED,
        grid_id: null,
      },
      select: { id: true },
    });
    if (cv || owner.offerId === undefined) return !!cv;
    return !!(await this.prisma.applicationAssessment.findFirst({
      where: {
        application: { job_offer_id: owner.offerId },
        score: { not: null },
        grid_id: null,
      },
      select: { id: true },
    }));
  }

  private async ask(job: Job): Promise<GridItem[] | null> {
    const messages: BaseMessage[] = proposalMessages(job);
    const call = async (input: BaseMessage[]) => {
      const options = {
        tier: 'document' as const,
        timeoutMs: LLM_TIMEOUT_MS,
        temperature: 0,
        correlationId: 'cv-grid',
      };
      const spec = parseSpec(cvScoringModel());
      // Any model may propose: it is marking that must come from one.
      const { output } = spec
        ? await this.llm
            .invokeWith(spec, input, options)
            .catch(() => this.llm.invoke(input, options))
        : await this.llm.invoke(input, options);
      return contentText(output.content);
    };
    const first = await call(messages);
    const read = parseProposal(first, { remote: job.remote });
    if (read) return read;
    const second = await call([
      ...messages,
      new AIMessage(first),
      new HumanMessage(JSON_REMINDER),
    ]);
    const again = parseProposal(second, { remote: job.remote });
    if (!again) {
      this.logger.warn(`Grid proposal unreadable: ${answerSnippet(second)}`);
    }
    return again;
  }

  // ── The business's side ──────────────────────────────────────────────

  /** The owner of a screening's grid, checked to be this business's. */
  async ofScreening(profileId: string, screeningId: string): Promise<GridOf> {
    const businessId = await this.requireBusiness(profileId);
    const s = await this.prisma.cvScreening.findFirst({
      where: { id: screeningId, business_id: businessId },
      select: { id: true, offer_id: true, job_title: true, job_text: true },
    });
    if (!s) throw new NotFoundException('Analyse introuvable.');
    if (s.offer_id) return this.ofOffer(profileId, s.offer_id);
    const owner: GridOwner = { screeningId: s.id };
    return {
      businessId,
      owner,
      job: { title: s.job_title, text: s.job_text, remote: false },
    };
  }

  async ofOffer(profileId: string, offerId: string): Promise<GridOf> {
    const businessId = await this.requireBusiness(profileId);
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: offerId, employer_id: profileId, deleted_at: null },
      select: OFFER_BRIEF,
    });
    if (!offer) throw new NotFoundException('Offre introuvable.');
    const owner: GridOwner = { offerId };
    return { businessId, owner, job: offerBrief(offer) };
  }

  /** The grid as its page shows it, and what a change would cost. */
  async view(found: GridOf) {
    const grid = await this.current(found.owner);
    const rows = await this.rows(found.owner);
    const stale = rows.filter((r) => r.gridId !== (grid?.id ?? null));
    const { used, limit } = await this.rescores(found.owner);
    return {
      /** Null: nothing read yet, or the previous formula. */
      grid: grid && {
        id: grid.id,
        version: grid.version,
        source: grid.source,
        items: grid.items,
      },
      /** The candidates have scores made by the previous formula. */
      previous: !grid && rows.length > 0,
      /** The offer was edited since this grid was made. */
      offerChanged: !!grid && grid.jobHash !== jobHash(found.job),
      scored: rows.length,
      /** Scored on other criteria: « Ré-analyser » brings them to these. */
      stale: grid ? stale.length : rows.length,
      rescoresLeft: Math.max(0, limit - used),
    };
  }

  /** The model's proposal for the offer as it is now; nothing is saved. */
  async propose(found: GridOf) {
    await this.requirePlan(found.businessId);
    const items = await this.ask(found.job).catch(() => null);
    if (!items) {
      throw new ServiceUnavailableException(
        'La proposition n’a pas abouti. Réessayez dans un instant.',
      );
    }
    return { items };
  }

  /**
   * A new version. Scores that need no new reading are computed again at once;
   * the others stay as they are until « Ré-analyser ».
   */
  async save(found: GridOf, input: GridInput[], memberId: string | null) {
    await this.requirePlan(found.businessId);
    await this.prisma.$transaction(async (tx) => {
      // Two people saving at once: one version after the other.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(found.owner)}))`;
      const before = await this.current(found.owner, tx);
      if (!before) await this.requireOn();
      if (!before && (await this.rows(found.owner, tx)).length > 0) {
        throw new BadRequestException(
          'Ré-analysez d’abord les candidats : cette offre utilise la méthode précédente.',
        );
      }
      let items: GridItem[];
      try {
        items = normaliseGrid(input, {
          strict: true,
          remote: found.job.remote,
          keys: new Set(before?.items.map((i) => i.key) ?? []),
        });
      } catch (err) {
        if (err instanceof GridError)
          throw new BadRequestException(err.message);
        throw err;
      }
      const row = await tx.cvGrid.create({
        data: {
          business_id: found.businessId,
          ...ownerWhere(found.owner),
          version: (before?.version ?? 0) + 1,
          items: items as unknown as Prisma.InputJsonValue,
          job_hash: jobHash(found.job),
          source: 'EDITED',
          // Its scores that are computed again were marked by that one.
          model: before?.model ?? cvScoringModel(),
          created_by: memberId,
        },
      });
      await this.recompute(tx, found.owner, toGrid(row));
    });
    return this.view(found);
  }

  /** The scores a new grid changes without the model: importances, durations, less items. */
  private async recompute(
    tx: Prisma.TransactionClient,
    owner: GridOwner,
    grid: Grid,
  ): Promise<void> {
    const older = await tx.cvGrid.findMany({
      where: { ...ownerWhere(owner), id: { not: grid.id } },
      select: { id: true, items: true },
    });
    const free = older
      .filter(
        (g) => !needsReading(g.items as unknown as GridItem[], grid.items),
      )
      .map((g) => g.id);
    if (free.length === 0) return;
    const [resumes, assessments] = await Promise.all([
      tx.cvScreeningResume.findMany({
        where: { grid_id: { in: free } },
        select: { id: true, reading: true },
      }),
      tx.applicationAssessment.findMany({
        where: { grid_id: { in: free } },
        select: { id: true, reading: true },
      }),
    ]);
    const data = (reading: Prisma.JsonValue) => {
      const read = readStored(reading);
      if (!read) return null;
      const e = evaluate(grid.items, read);
      return { score: e.score, musts_missing: e.missing, grid_id: grid.id };
    };
    for (const r of resumes) {
      const next = data(r.reading);
      if (next) {
        await tx.cvScreeningResume.update({ where: { id: r.id }, data: next });
      }
    }
    for (const a of assessments) {
      const next = data(a.reading);
      if (next) {
        await tx.applicationAssessment.update({
          where: { id: a.id },
          data: next,
        });
      }
    }
  }

  /** Why one candidate is ahead of another: the must-haves, then each criterion. */
  async explain(
    profileId: string,
    screeningId: string,
    aId: string,
    bId: string,
  ) {
    const businessId = await this.requireBusiness(profileId);
    const rows = await this.prisma.cvScreeningResume.findMany({
      where: {
        id: { in: [aId, bId] },
        status: CvScreeningResumeStatus.SCORED,
        screening: { id: screeningId, business_id: businessId },
      },
      include: { grid: true },
    });
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    if (!a || !b || aId === bId) throw new NotFoundException('CV introuvable.');
    const readA = readStored(a.reading);
    const readB = readStored(b.reading);
    if (!a.grid || a.grid_id !== b.grid_id || !readA || !readB) {
      // Two formulas, or two versions: their points do not compare.
      return { comparable: false as const };
    }
    const { items } = toGrid(a.grid);
    const fit = items.filter(isFit);
    const ea = evaluate(items, readA);
    const eb = evaluate(items, readB);
    const { gap, rows: gaps } = explainGap(fit, ea.marks, eb.marks);
    const label = new Map(items.map((i) => [i.key, i.label]));
    const shownA = new Map(points(fit, ea.marks).map((p) => [p.key, p.shown]));
    const shownB = new Map(points(fit, eb.marks).map((p) => [p.key, p.shown]));
    return {
      comparable: true as const,
      scores: { a: ea.score, b: eb.score },
      gap: round1(gap),
      /** What puts one first: must-haves come before the score. */
      decidedBy:
        ea.missing !== eb.missing
          ? ('MUSTS' as const)
          : ea.score !== eb.score
            ? ('SCORE' as const)
            : ('TIE' as const),
      criteria: gaps.map((g) => ({
        key: g.key,
        label: label.get(g.key) ?? '',
        a: { mark: g.a, points: shownA.get(g.key) ?? 0 },
        b: { mark: g.b, points: shownB.get(g.key) ?? 0 },
        diff: round1(g.diff),
      })),
      musts: items.filter(isMust).map((m) => ({
        key: m.key,
        label: m.label,
        a: ea.musts[m.key],
        b: eb.musts[m.key],
      })),
    };
  }

  // ── Shared with the re-analysis ──────────────────────────────────────

  /** Every scored candidate of the owner: CVs, and profiles without one. */
  async rows(owner: GridOwner, db: Db = this.prisma) {
    const screening =
      owner.offerId !== undefined
        ? { offer_id: owner.offerId }
        : { id: owner.screeningId };
    const resumes = await db.cvScreeningResume.findMany({
      where: { screening, status: CvScreeningResumeStatus.SCORED },
      select: { id: true, grid_id: true, screening_id: true },
    });
    const profiles =
      owner.offerId === undefined
        ? []
        : await db.applicationAssessment.findMany({
            where: {
              application: {
                job_offer_id: owner.offerId,
                deleted_at: null,
                // Its CV analysis, once in, is its score.
                OR: [
                  { cv_resume_id: null },
                  {
                    cv_resume: {
                      status: { not: CvScreeningResumeStatus.SCORED },
                    },
                  },
                ],
              },
              score: { not: null },
            },
            select: { id: true, grid_id: true, application_id: true },
          });
    return [
      ...resumes.map((r) => ({
        kind: 'cv' as const,
        id: r.id,
        gridId: r.grid_id,
        screeningId: r.screening_id,
      })),
      ...profiles.map((p) => ({
        kind: 'profile' as const,
        id: p.application_id,
        gridId: p.grid_id,
        screeningId: null,
      })),
    ];
  }

  /** The free re-analyses used and allowed. */
  async rescores(owner: GridOwner) {
    const [limit, agg] = await Promise.all([
      this.systemConfig.getCvRescoreLimit(),
      this.prisma.cvScreening.aggregate({
        where:
          owner.offerId !== undefined
            ? { offer_id: owner.offerId }
            : { id: owner.screeningId },
        _max: { rescores: true },
      }),
    ]);
    return {
      limit,
      used: agg._max.rescores ?? 0,
      /** Kept on the screenings: none yet, nothing to count on. */
      counted: agg._max.rescores !== null,
    };
  }

  /** New grids are made only once the method is switched on. */
  async requireOn(): Promise<void> {
    if (!(await this.systemConfig.getCvGridScoring())) {
      throw new ForbiddenException(
        'Les critères par offre ne sont pas encore disponibles.',
      );
    }
  }

  async requirePlan(businessId: string): Promise<void> {
    const e = await this.subscriptions.entitlements(businessId);
    if (!e.plan) {
      throw new ForbiddenException(
        'Les critères se modifient avec une formule en cours. Choisissez-en une depuis la rubrique « Abonnement ».',
      );
    }
  }

  private async requireBusiness(profileId: string): Promise<string> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    return businessId;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p: unknown) =>
      p && typeof p === 'object' && 'text' in p && typeof p.text === 'string'
        ? p.text
        : '',
    )
    .join('');
}
