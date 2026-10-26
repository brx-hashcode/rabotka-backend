import {
  BUSINESS_IDENTITY_SELECT,
  publicEmployerName,
} from '../business/public-employer';
import { PRIORITY_FIRST } from '../business/subscription/subscription-where';
import {
  CHATTABLE_APPLICATION_ORDER,
  CHATTABLE_APPLICATION_SELECT,
  applicationSummaries,
  isApplied,
} from './chattable-applications';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { toWorkerJobShape } from './worker-job-shape';
import { withCityFilter } from '../../common/queries/city-filter';
import {
  ApplicationStatus,
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  JobOfferStatus,
  PaymentFlow,
  Prisma,
  ProfileType,
} from '@prisma/client';
import {
  foldedText,
  pageByTier,
  searchClauses,
  searchTokens,
  sectorsOf,
  splitTiers,
} from '../../common/queries/text-search';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JobOfferService } from '../job-offer/job-offer.service';
import { UpdateJobOfferDto } from '../job-offer/dto/update-job-offer.dto';
import { ApplicationService } from '../application/application.service';
import { MatchingService } from '../matching/matching.service';
import { EngineRolloutService } from '../recommendation-engine/engine-rollout.service';
import { InteractionEventService } from '../recommendation-engine/interaction-event.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';

/** Offers a worker can still apply to. */
const OPEN_JOB_STATUSES = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

const JOB_SEARCH_SORTS = ['recent', 'soon', 'amount_desc'] as const;
type JobSearchSort = (typeof JOB_SEARCH_SORTS)[number];

/**
 * Raw job-search query string params. A plain type (not a class DTO) so the
 * global ValidationPipe treats the metatype as `Object` and passes it through
 * untouched — every field is hand-validated below, matching how the other
 * mobile endpoints handle their `@Query('x') x?: string` params.
 */
type JobSearchQuery = {
  q?: string;
  categoryId?: string;
  city?: string;
  paymentFlow?: string;
  minAmount?: string;
  maxAmount?: string;
  from?: string;
  to?: string;
  hideApplied?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
};

/**
 * Search results are built from a single findMany (not hydrateWorkerJobs, which
 * issues one findById per hit) and deliberately omit the employer's phone.
 */
const JOB_SEARCH_SELECT = {
  id: true,
  reference: true,
  title: true,
  description: true,
  status: true,
  scheduled_at: true,
  amount: true,
  payment_flow: true,
  address: true,
  // The worker's detail screen shows where the job is, and "where" is not just
  // the street: a remote job has no address at all, and an address alone hides
  // which city it is in. Selecting only `address` is what left the client's
  // jobLocationDetail() with nothing to add.
  is_remote: true,
  employment_type: true,
  city: true,
  country_name: true,
  quantity: true,
  created_at: true,
  category: { select: { id: true, name: true } },
  employer: {
    select: {
      id: true,
      first_name: true,
      last_name: true,
      reliability_score: true,
      avatar_url: true,
      rating_avg: true,
      rating_count: true,
      ...BUSINESS_IDENTITY_SELECT,
    },
  },
  _count: {
    select: {
      applications: { where: { status: ApplicationStatus.ACCEPTED } },
    },
  },
} satisfies Prisma.JobOfferSelect;

/**
 * Profile-facing (mobile) read endpoints. Thin role-gated wrappers over the
 * existing job-offer / application / matching services that were previously only
 * reachable via admin controllers or the WhatsApp bot.
 */
@ApiTags('Mobile — Feed')
@ApiBearerAuth()
@Controller('profile')
@UseGuards(ProfileAuthGuard)
export class MobileFeedController {
  private readonly logger = new Logger(MobileFeedController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobOfferService: JobOfferService,
    private readonly applicationService: ApplicationService,
    private readonly matchingService: MatchingService,
    private readonly rollout: EngineRolloutService,
    private readonly engine: RecommendationEngineService,
    private readonly interactionEvents: InteractionEventService,
  ) {}

  @Get('job-feed')
  @ApiOperation({
    summary:
      '[Mobile/WORKER] Job offers for the worker (matched or by category)',
    description:
      'With categoryId: open offers in that domain, newest first. Without: "Pour vous" — semantic recommendations when similarity is enabled, otherwise the worker\'s own domains newest-first (all open offers if they have no domains). Each item carries `saved`, `applied` and `matchScore`.',
  })
  @ApiResponse({ status: 200, description: 'Job offers' })
  @ApiResponse({ status: 403, description: 'Not a WORKER profile' })
  async jobFeed(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('limit') limit?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);

    const topN = this.parseInt(limit, 10, 50);

    // A domain chip pins the feed to that single category.
    if (categoryId) {
      return this.hydrateWorkerJobs(
        profileId,
        await this.recentOpenOfferHits([categoryId], topN),
        { surface: 'job_feed_category', requestId: req.requestId },
      );
    }

    // "Pour vous" = ranked first, then topped up to the page size.
    //
    // The ranked set is never authoritative about what EXISTS: an offer
    // published a minute ago may not be in Qdrant yet, and the score threshold
    // and per-category diversity cap both drop offers on purpose. Returning
    // only those hits made "Pour vous" show one item while a domain chip listed
    // several — the chips read Postgres directly, so the personalised tab
    // looked broken. Ranking now decides ORDER, not membership.
    const matched = await this.keepOpenOffers(
      (await this.rankForYou(profileId, topN)) ?? [],
    );

    const workerCategoryIds = await this.workerCategoryIds(profileId);
    const [ownDomains, everythingElse] = await Promise.all([
      this.recentOpenOfferHits(workerCategoryIds, topN),
      this.recentOpenOfferHits([], topN),
    ]);

    return this.hydrateWorkerJobs(
      profileId,
      this.dedupeHits([...matched, ...ownDomains, ...everythingElse], topN),
      { surface: 'job_feed', requestId: req.requestId },
    );
  }

  /** First occurrence wins, so relevance order survives the top-up. */
  private dedupeHits(
    hits: { id: string; score: number }[],
    take: number,
  ): { id: string; score: number }[] {
    const seen = new Set<string>();
    const out: { id: string; score: number }[] = [];

    for (const hit of hits) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
      if (out.length === take) break;
    }

    return out;
  }

  /**
   * Ranks the personalized feed with whichever engine this profile is bucketed
   * onto. v2 failing must degrade to legacy, never to an empty feed.
   */
  private async rankForYou(
    profileId: string,
    topN: number,
  ): Promise<{ id: string; score: number }[]> {
    if ((await this.rollout.versionFor(profileId)) === 'v2') {
      try {
        const ranked = await this.engine.recommendJobsForWorker(
          profileId,
          topN,
        );
        if (ranked.length > 0) {
          return ranked.map((r) => ({ id: r.id, score: r.score }));
        }
      } catch (err) {
        this.logger.warn(`v2 ranker failed for ${profileId}`, err);
      }
    }
    return (
      (await this.matchingService.findMatchingJobsForWorker(profileId, topN)) ??
      []
    );
  }

  /** Open, non-deleted offers newest-first, optionally narrowed to categories. */
  private async recentOpenOfferHits(
    categoryIds: string[],
    take: number,
  ): Promise<{ id: string; score: number }[]> {
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        deleted_at: null,
        ...(categoryIds.length > 0 ? { category_id: { in: categoryIds } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take,
      select: { id: true },
    });
    return rows.map((r) => ({ id: r.id, score: 0 }));
  }

  /**
   * Drops matched offers that are no longer open. The Qdrant query filters on
   * categoryId only, so a stale vector index can surface FILLED / soft-deleted
   * offers the worker cannot apply to. Relevance order is preserved.
   */
  private async keepOpenOffers(
    hits: { id: string; score: number }[],
  ): Promise<{ id: string; score: number }[]> {
    if (hits.length === 0) return hits;
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        id: { in: hits.map((h) => h.id) },
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        deleted_at: null,
      },
      select: { id: true },
    });
    const open = new Set(rows.map((r) => r.id));
    return hits.filter((h) => open.has(h.id));
  }

  /** The worker's chosen domains — same source as the profile's `categoryIds`. */
  private async workerCategoryIds(profileId: string): Promise<string[]> {
    const rows = await this.prisma.profileCategory.findMany({
      where: { profile_id: profileId },
      select: { category_id: true },
    });
    return rows.map((r) => r.category_id);
  }

  @Get('job-search')
  @ApiOperation({
    summary:
      '[Mobile/WORKER] Search job offers (title/description/domaine/reference/address + filters)',
    description:
      'Free-text search across title, description, address, reference and category name, plus category/city/payment-flow/amount/date filters. Paginated (0-based) as { items, total }.',
  })
  @ApiResponse({ status: 200, description: 'Paginated job search results' })
  @ApiResponse({ status: 403, description: 'Not a WORKER profile' })
  async jobSearch(
    @Req() req: ProfileAuthenticatedRequest,
    @Query() query: JobSearchQuery,
  ) {
    const {
      q,
      categoryId,
      city,
      paymentFlow,
      minAmount,
      maxAmount,
      from,
      to,
      hideApplied,
      sort,
      page,
      pageSize,
    } = query;

    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);

    const take = this.parseLimit(pageSize, 15, 50);
    const pageNum = this.parseInt(page, 0, 10_000);
    const skip = pageNum * take;

    // Base eligibility. ACTIVE/PARTIALLY_FILLED already implies "has open slots":
    // accept() flips an offer to FILLED once accepted >= quantity, so there is no
    // need to re-derive slot availability here.
    let where: Prisma.JobOfferWhereInput = {
      status: { in: OPEN_JOB_STATUSES },
      deleted_at: null,
    };

    if (categoryId) {
      where.category_id = categoryId;
    }
    // Structured `city` first, free-text `address` as the fallback — see
    // withCityFilter for why both.
    where = withCityFilter(where, city);
    if (paymentFlow && paymentFlow in PaymentFlow) {
      where.payment_flow = paymentFlow as PaymentFlow;
    }

    const amountRange = this.numericRange(minAmount, maxAmount);
    if (amountRange) {
      where.amount = amountRange;
    }
    const dateRange = this.dateRange(from, to);
    if (dateRange) {
      where.scheduled_at = dateRange;
    }
    if (hideApplied === '1' || hideApplied === 'true') {
      where.applications = { none: { worker_id: profileId } };
    }

    // Forgiving text search — accents, word order, partial words, other
    // forms and misspellings, and the rest of the sector after the offers
    // that say it (common/queries/text-search.ts).
    const orderBy = this.jobSearchOrderBy(sort);
    const find = (w: Prisma.JobOfferWhereInput, s: number, t: number) =>
      this.prisma.jobOffer.findMany({
        where: w,
        select: JOB_SEARCH_SELECT,
        orderBy,
        skip: s,
        take: t,
      });

    let rows: Awaited<ReturnType<typeof find>>;
    let total: number;
    const tokens = searchTokens(q);
    if (tokens.length > 0) {
      const { match, direct } = searchClauses(
        tokens,
        {
          // The category is not the job's own text: a word naming it reaches
          // the job through its sector, after the jobs whose title says it.
          fuzzy: foldedText(Prisma.sql`o.title`),
          // Long or code-like fields: as written (accents aside) only, since
          // a "close" word somewhere in a description is noise. `reference`
          // matches legacy RAB-* rows and lowercase input alike.
          exact: [
            foldedText(Prisma.sql`o.description`),
            foldedText(Prisma.sql`o.address`),
            foldedText(Prisma.sql`o.reference`),
          ],
        },
        await sectorsOf(this.prisma, tokens),
        (ids) => Prisma.sql`o.category_id::text IN (${ids})`,
      );
      const hits = await this.prisma.$queryRaw<
        { id: string; direct: boolean }[]
      >`
        SELECT o.id, ${direct} AS direct
        FROM job_offers o
        WHERE o.deleted_at IS NULL
          AND o.status::text IN (${Prisma.join(OPEN_JOB_STATUSES)})
          AND ${match}
      `;
      // The offers that say it first, then the rest of their sector. By id,
      // so the search composes with the filters above — the city filter
      // included, which also lives in `where.AND`.
      const within = (ids: string[]) => ({ ...where, id: { in: ids } });
      ({ rows, total } = await pageByTier(splitTiers(hits), skip, take, {
        count: (ids) => this.prisma.jobOffer.count({ where: within(ids) }),
        rows: (ids, s, t) => find(within(ids), s, t),
      }));
    } else {
      [rows, total] = await Promise.all([
        find(where, skip, take),
        this.prisma.jobOffer.count({ where }),
      ]);
    }

    const ids = rows.map((r) => r.id);
    const [saved, applied] = await Promise.all([
      ids.length
        ? this.prisma.savedJob.findMany({
            where: { profile_id: profileId, job_offer_id: { in: ids } },
            select: { job_offer_id: true },
          })
        : Promise.resolve([]),
      ids.length
        ? this.prisma.application.findMany({
            where: { worker_id: profileId, job_offer_id: { in: ids } },
            select: CHATTABLE_APPLICATION_SELECT,
            orderBy: CHATTABLE_APPLICATION_ORDER,
          })
        : Promise.resolve([]),
    ]);
    const savedSet = new Set(saved.map((s) => s.job_offer_id));
    // One summary per offer, from the SAME rule the apply endpoint uses —
    // see chattable-applications.ts for what the old boolean got wrong.
    const summaries = applicationSummaries(applied);

    // Built through toWorkerJobShape rather than field by field: the explicit
    // list here used to omit is_remote, employment_type, city and country_name
    // entirely, even though the shared select fetches all four.
    const items = rows.map(({ category, _count, employer, ...r }) => ({
      ...toWorkerJobShape({
        ...r,
        // A business shows as itself, without its contact fields.
        employer: employer && {
          id: employer.id,
          ...publicEmployerName(employer),
          reliability_score: employer.reliability_score,
          avatar_url: employer.avatar_url,
          rating_avg: employer.rating_avg,
          rating_count: employer.rating_count,
        },
      }),
      // Prisma Decimal → number, which is what the client's type declares.
      amount: r.amount == null ? null : Number(r.amount),
      acceptedCount: _count.applications,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      matchScore: 0,
      saved: savedSet.has(r.id),
      applied: isApplied(summaries.get(r.id)),
      applicationState: summaries.get(r.id)?.state ?? 'NONE',
      applicationId: summaries.get(r.id)?.applicationId ?? null,
    }));

    // `offset: skip` — otherwise every page restarts at position 0 and
    // position-bias analysis is meaningless.
    void this.interactionEvents.recordImpressions({
      actorId: profileId,
      actorType: InteractionActor.WORKER,
      objectType: InteractionObject.JOB_OFFER,
      items: items.map((it) => ({ objectId: it.id })),
      surface: 'job_search',
      requestId: req.requestId,
      offset: skip,
    });

    return { items, total };
  }

  @Get('jobs/:jobOfferId')
  @ApiOperation({
    summary: '[Mobile/WORKER] Job offer detail (with saved/applied flags)',
  })
  @ApiResponse({ status: 200, description: 'Job offer detail' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async jobDetail(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('jobOfferId') jobOfferId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);
    const [job] = await this.hydrateWorkerJobs(profileId, [
      { id: jobOfferId, score: 0 },
    ]);
    if (!job) {
      throw new NotFoundException('Offre introuvable');
    }

    // The single largest hole in the interest graph before this: a worker could
    // open two hundred offers and it learned nothing. VIEW carries real weight
    // (0.3), so categoryId matters here in a way it does not for a zero-weight
    // impression — hence the extra lookup.
    const category = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: { category_id: true },
    });
    void this.interactionEvents.record({
      actorId: profileId,
      actorType: InteractionActor.WORKER,
      kind: InteractionKind.VIEW,
      objectType: InteractionObject.JOB_OFFER,
      objectId: jobOfferId,
      categoryId: category?.category_id,
      counterpartyId: job.employer_id,
      source: InteractionSource.SERVER,
      surface: 'job_detail',
      requestId: req.requestId,
    });

    return job;
  }

  @Post('jobs/:jobOfferId/apply')
  @UseGuards(ActiveProfileGuard, KycVerifiedGuard)
  @ApiOperation({
    summary: '[Mobile/WORKER] Apply to a job offer',
    description:
      'Creates an application (subject to duplicate / penalty / concurrent / daily-limit guards) and returns the updated daily quota.',
  })
  @ApiResponse({ status: 201, description: 'Application created' })
  @ApiResponse({
    status: 403,
    description: 'Not a WORKER / blocked / limit reached',
  })
  @ApiResponse({ status: 409, description: 'Already applied' })
  async applyToJob(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('jobOfferId') jobOfferId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);
    await this.applicationService.create(jobOfferId, profileId);
    const dailyQuota =
      await this.applicationService.getDailyApplicationQuota(profileId);
    return { success: true, dailyQuota };
  }

  @Get('daily-application-quota')
  @ApiOperation({
    summary: '[Mobile/WORKER] Remaining applications for today',
  })
  @ApiResponse({ status: 200, description: 'Daily application quota' })
  async dailyApplicationQuota(@Req() req: ProfileAuthenticatedRequest) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);
    return this.applicationService.getDailyApplicationQuota(profileId);
  }

  /**
   * Hydrate matched/category hits into full offers (preserving order) and attach
   * the worker's `saved` (bookmarked) and `applied` flags via batch lookups.
   */
  /**
   * @param impression When set, the returned list is recorded as an
   * IMPRESSION_BATCH. Opt-in because `jobDetail` hydrates through here too, and
   * opening one offer is a VIEW, not an impression of a feed.
   */
  private async hydrateWorkerJobs(
    profileId: string,
    hits: { id: string; score: number }[],
    impression?: { surface: string; requestId?: string; offset?: number },
  ) {
    const offers = (
      await Promise.all(hits.map((h) => this.jobOfferService.findById(h.id)))
    ).filter((o): o is NonNullable<typeof o> => o !== null);
    const ids = offers.map((o) => o.id);

    const [saved, applied] = await Promise.all([
      ids.length
        ? this.prisma.savedJob.findMany({
            where: { profile_id: profileId, job_offer_id: { in: ids } },
            select: { job_offer_id: true },
          })
        : Promise.resolve([]),
      ids.length
        ? this.prisma.application.findMany({
            where: { worker_id: profileId, job_offer_id: { in: ids } },
            select: CHATTABLE_APPLICATION_SELECT,
            orderBy: CHATTABLE_APPLICATION_ORDER,
          })
        : Promise.resolve([]),
    ]);
    const savedSet = new Set(saved.map((s) => s.job_offer_id));
    // One summary per offer, from the SAME rule the apply endpoint uses —
    // see chattable-applications.ts for what the old boolean got wrong.
    const summaries = applicationSummaries(applied);
    const scoreById = new Map(hits.map((h) => [h.id, h.score]));

    const hydrated = offers.map((o) => ({
      ...toWorkerJobShape(o),
      matchScore: scoreById.get(o.id) ?? 0,
      saved: savedSet.has(o.id),
      applied: isApplied(summaries.get(o.id)),
      applicationState: summaries.get(o.id)?.state ?? 'NONE',
      applicationId: summaries.get(o.id)?.applicationId ?? null,
    }));

    if (impression) {
      void this.interactionEvents.recordImpressions({
        actorId: profileId,
        actorType: InteractionActor.WORKER,
        objectType: InteractionObject.JOB_OFFER,
        items: hydrated.map((o) => ({
          objectId: o.id,
          counterpartyId: o.employer_id,
        })),
        surface: impression.surface,
        requestId: impression.requestId,
        offset: impression.offset,
      });
    }

    return hydrated;
  }

  @Get('job-offers')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] My job offers',
    description:
      'Returns the job offers created by the authenticated employer. `status` takes a comma-separated list (e.g. PARTIALLY_FILLED,FILLED,IN_PROGRESS) and is applied before pagination, so pages stay full and `total` reflects the filter.',
  })
  @ApiResponse({ status: 200, description: 'The employer’s job offers' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async myJobOffers(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    return this.jobOfferService.findByEmployerId(profileId, {
      page: this.parseInt(page, 0, 10_000),
      pageSize: this.parseLimit(pageSize, 20, 100),
      statuses: this.parseStatuses(status),
    });
  }

  /** Comma-separated JobOfferStatus list; unknown values are dropped. */
  private parseStatuses(value?: string): JobOfferStatus[] | undefined {
    if (!value?.trim()) return undefined;
    const parsed = value
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s): s is JobOfferStatus => s in JobOfferStatus);
    return parsed.length > 0 ? parsed : undefined;
  }

  @Get('job-offers/:id/applications')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Workers on one of my offers',
    description:
      'Applications (with worker info) for a single job offer owned by the authenticated employer. Powers the mission/offer detail workers list.',
  })
  @ApiResponse({ status: 200, description: 'Applications for the offer' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER / not the owner' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async jobOfferApplications(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    const offer = await this.jobOfferService.findById(id);
    if (!offer) {
      throw new NotFoundException('Offre introuvable');
    }
    if (offer.employer_id !== profileId) {
      throw new ForbiddenException(
        "Vous n'êtes pas l'employeur de cette offre",
      );
    }

    return this.applicationService.findByJobOffer(id);
  }

  @Get('received-applications')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Applications received',
    description:
      'Applications submitted to the employer’s offers. Powers both the Candidats (roster) and Applications (pipeline) views.',
  })
  @ApiResponse({ status: 200, description: 'Received applications' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async receivedApplications(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    return this.applicationService.findByEmployer(profileId, {
      page: this.parseInt(page, 0, 10_000),
      pageSize: this.parseInt(pageSize, 20, 100),
    });
  }

  @Post('job-offers/:id/confirm-hire')
  @UseGuards(ActiveProfileGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Confirm the hire on a CDD/CDI/STAGE offer',
    description:
      'Closes an offer whose positions are all taken, and opens the mutual rating. Only for ongoing engagements — a MISSION is closed by its worker confirming the work is done. Requires the offer to be FILLED, so an offer still taking candidates cannot be closed early. Idempotent once closed.',
  })
  @ApiResponse({ status: 200, description: 'Offer closed, rating open' })
  @ApiResponse({
    status: 400,
    description: 'Still recruiting, or a MISSION',
  })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER / not the owner' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async confirmHire(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    await this.applicationService.confirmHireByEmployer(id, profileId);
    return { success: true };
  }

  @Patch('job-offers/:id')
  @UseGuards(ActiveProfileGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Edit one of my job offers',
    description:
      'Edits a job offer owned by the authenticated employer while it is ACTIVE. Omitted fields are left alone; the merged offer must pass the creation rules. A changed date must be at least 4h ahead, the employment type is locked once someone has applied, and quantity cannot drop below the slots already taken. Candidates still on the offer are notified when the pay, date or place changes.',
  })
  @ApiResponse({ status: 200, description: 'The updated job offer' })
  @ApiResponse({
    status: 400,
    description: 'Not ACTIVE, or the edit breaks a rule',
  })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER / not the owner' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async updateJobOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateJobOfferDto,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    return this.jobOfferService.updateByEmployer(id, profileId, dto);
  }

  @Delete('job-offers/:id')
  @UseGuards(ActiveProfileGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Delete one of my job offers',
    description:
      'Soft-deletes a job offer owned by the authenticated employer. Allowed while the offer is ACTIVE or EXPIRED and no worker is engaged on it (no WAITING_PAYMENT / ACCEPTED / STARTED / END application, no confirmed or completed assignment). Candidates still waiting (PENDING / VIEWED) are closed with it and notified.',
  })
  @ApiResponse({ status: 200, description: 'Job offer deleted' })
  @ApiResponse({
    status: 400,
    description: 'A worker is engaged on the offer, or it is in progress',
  })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER / not the owner' })
  @ApiResponse({ status: 404, description: 'Job offer not found' })
  async deleteJobOffer(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    await this.jobOfferService.deleteByEmployer(id, profileId);
    return { success: true };
  }

  private parseInt(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n < 0) return fallback;
    return Math.min(n, max);
  }

  /**
   * Like parseInt but rejects 0 — a page SIZE of 0 would mean `take: 0` and a
   * permanently empty result set, whereas a page INDEX of 0 is legitimate.
   */
  private parseLimit(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n <= 0) return fallback;
    return Math.min(n, max);
  }

  /** Builds a Prisma numeric range, or undefined when neither bound parses. */
  private numericRange(
    min?: string,
    max?: string,
  ): Prisma.DecimalFilter | undefined {
    const lo = Number(min);
    const hi = Number(max);
    const hasLo = min != null && min !== '' && Number.isFinite(lo);
    const hasHi = max != null && max !== '' && Number.isFinite(hi);
    if (!hasLo && !hasHi) return undefined;
    return {
      ...(hasLo ? { gte: lo } : {}),
      ...(hasHi ? { lte: hi } : {}),
    };
  }

  /** Builds a Prisma date range, or undefined when neither bound parses. */
  private dateRange(
    from?: string,
    to?: string,
  ): Prisma.DateTimeFilter | undefined {
    const lo = from ? new Date(from) : null;
    const hi = to ? new Date(to) : null;
    const hasLo = lo != null && !Number.isNaN(lo.getTime());
    const hasHi = hi != null && !Number.isNaN(hi.getTime());
    if (!hasLo && !hasHi) return undefined;
    return {
      ...(hasLo ? { gte: lo } : {}),
      ...(hasHi ? { lte: hi } : {}),
    };
  }

  /**
   * Every sort ends on `id` so offset pagination can't duplicate or skip a row
   * when two offers tie. `nulls: 'last'` matters for amount — it's nullable, so
   * unpriced offers would otherwise lead the "best paid" list.
   */
  private jobSearchOrderBy(
    sort?: string,
  ): Prisma.JobOfferOrderByWithRelationInput[] {
    const key: JobSearchSort = JOB_SEARCH_SORTS.includes(sort as JobSearchSort)
      ? (sort as JobSearchSort)
      : 'recent';
    if (key === 'soon') {
      return [{ scheduled_at: 'asc' }, { created_at: 'desc' }, { id: 'asc' }];
    }
    if (key === 'amount_desc') {
      return [
        { amount: { sort: 'desc', nulls: 'last' } },
        { created_at: 'desc' },
        { id: 'asc' },
      ];
    }
    // Default order: a business plan with priority visibility first.
    return [PRIORITY_FIRST, { created_at: 'desc' }, { id: 'asc' }];
  }

  private async assertProfileType(
    profileId: string,
    expected: ProfileType,
  ): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== expected) {
      throw new ForbiddenException(
        expected === ProfileType.WORKER
          ? 'Réservé aux travailleurs'
          : 'Réservé aux employeurs',
      );
    }
  }
}
