import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
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
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  Prisma,
  ProfileType,
  PaymentRequestType,
  PaymentRequestStatus,
  VerificationStatus,
} from '@prisma/client';
import { ContactedProfilesService } from '../recommendation/contacted-profiles.service';
import { withCityFilter } from '../../common/queries/city-filter';
import { PortfolioService } from '../portfolio/portfolio.service';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { KycVerifiedGuard } from '../auth/guards/kyc-verified.guard';
import { ActiveProfileGuard } from '../auth/guards/active-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { MatchingService } from '../matching/matching.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { RecommendationContactService } from '../recommendation/recommendation-contact.service';
import { InteractionEventService } from '../recommendation-engine/interaction-event.service';
import { EngineRolloutService } from '../recommendation-engine/engine-rollout.service';
import { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';

const WORKER_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  avatar_url: true,
  reliability_score: true,
  rating_avg: true,
  rating_count: true,
  description: true,
  portfolio_slug: true,
  // Address only — never phone or email. The public portfolio already shows it
  // (PortfolioHeader), whereas contact details are what the unlock fee buys.
  address: true,
  verification_status: true,
  // No `take: 1`: an employer choosing between workers needs every domain, and
  // truncating to one made a multi-skilled worker look like a specialist.
  categories: {
    select: { category: { select: { name: true } } },
  },
} as const;

/**
 * Which ranker produced the hits, for the diagnostic log only.
 *
 * `disabled` means no ranker ran at all because `matching.use_embeddings` is
 * off — distinct from a ranker that ran and matched nothing, which is what the
 * feed looked like from the outside before this was reported.
 */
type FeedEngine = 'v2' | 'legacy' | 'disabled';

/** Which of the three tiers actually answered. */
type FeedTier = 'ranked' | 'in_domain' | 'any_eligible';

type RecommendedWorker = {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  reliabilityScore: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  /** First domain, kept for the compact card. */
  categoryName: string | null;
  /** Every domain, for the detail page. */
  categoryNames: string[];
  description: string | null;
  address: string | null;
  /**
   * Only ever true. PENDING and REJECTED are moderation outcomes, and telling
   * every employer that a worker is "not verified" punishes them for a review
   * queue they do not control — so the absence of a badge says nothing.
   */
  isVerified: boolean;
  completedMissions: number;
  portfolioSlug: string | null;
  score: number;
};

@ApiTags('Mobile — Recommendations')
@ApiBearerAuth()
@Controller('profile')
@UseGuards(ProfileAuthGuard)
export class MobileRecommendationController {
  private readonly logger = new Logger(MobileRecommendationController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matching: MatchingService,
    private readonly systemConfig: SystemConfigService,
    private readonly wallet: WalletService,
    private readonly recommendationContact: RecommendationContactService,
    private readonly interactionEvents: InteractionEventService,
    private readonly rollout: EngineRolloutService,
    private readonly engine: RecommendationEngineService,
    private readonly contactedProfiles: ContactedProfilesService,
    private readonly portfolio: PortfolioService,
  ) {}

  @Get('worker-feed')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Recommended worker profiles',
    description:
      'Semantic recommendations when similarity is enabled; otherwise workers in the domains this employer posts offers in, best reliability/rating first, then any eligible worker. Already-contacted workers are excluded at every tier.',
  })
  @ApiResponse({ status: 200, description: 'Ranked recommended workers' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async workerFeed(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('limit') limit?: string,
  ): Promise<RecommendedWorker[]> {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);

    const topN = this.parseLimit(limit, 20, 50);
    const contactedIds =
      await this.contactedProfiles.listContactedWorkerIds(profileId);

    const {
      workers: served,
      engine,
      tier,
    } = await this.resolveWorkerFeed(profileId, topN, contactedIds);

    // The feed degrades silently by design — every tier returns a plausible list
    // — so without this line a production feed serving `score: 0` from the SQL
    // fallback is indistinguishable from a ranker that genuinely scored everyone
    // 0. `engine=disabled tier=any_eligible` says "no ranker ran" at a glance.
    this.logger.log(
      `worker-feed profile=${profileId} engine=${engine} tier=${tier} count=${served.length} topScore=${served[0]?.score.toFixed(4) ?? 'n/a'}`,
    );

    // Recorded once on whatever tier actually answered, rather than at each of
    // the three exits. Without this the employer feed is frozen: the ranker
    // seen-suppresses on [PROFILE_VIEW, IMPRESSION_BATCH], and only workers
    // whose detail page was opened were ever suppressed — anyone merely
    // scrolled past resurfaced on every refresh.
    void this.interactionEvents.recordImpressions({
      actorId: profileId,
      actorType: InteractionActor.EMPLOYER,
      objectType: InteractionObject.WORKER_PROFILE,
      items: served.map((w) => ({ objectId: w.id })),
      surface: 'worker_feed',
      requestId: req.requestId,
    });

    return served;
  }

  /** The three tiers, best first: ranked → in-domain → any eligible worker. */
  private async resolveWorkerFeed(
    profileId: string,
    topN: number,
    contactedIds: Set<string>,
  ): Promise<{
    workers: RecommendedWorker[];
    engine: FeedEngine;
    tier: FeedTier;
  }> {
    const { hits, engine } = await this.rankWorkers(
      profileId,
      topN,
      contactedIds,
    );
    const recommended = await this.hydrate(
      hits.filter((h) => !contactedIds.has(h.id)).slice(0, topN),
    );
    if (recommended.length > 0) {
      return { workers: recommended, engine, tier: 'ranked' };
    }

    const categoryIds = await this.employerCategoryIds(profileId);
    if (categoryIds.length > 0) {
      const inDomain = await this.hydrate(
        await this.eligibleWorkerHits(categoryIds, contactedIds, topN),
      );
      if (inDomain.length > 0) {
        return { workers: inDomain, engine, tier: 'in_domain' };
      }
    }

    return {
      workers: await this.hydrate(
        await this.eligibleWorkerHits([], contactedIds, topN),
      ),
      engine,
      tier: 'any_eligible',
    };
  }

  private async rankWorkers(
    profileId: string,
    topN: number,
    contactedIds: Set<string>,
  ): Promise<{ hits: { id: string; score: number }[]; engine: FeedEngine }> {
    // Reported separately from the tier because the two answer different
    // questions: the tier says which list the employer got, `engine` says
    // whether a ranker was ever consulted. `disabled` is the one that matters —
    // the legacy ranker returns an empty array on its first line when
    // `matching.use_embeddings` is off, which is indistinguishable from
    // "nothing matched" everywhere downstream.
    if (!(await this.systemConfig.isSimilarityEnabled())) {
      return { hits: [], engine: 'disabled' };
    }

    if ((await this.rollout.versionFor(profileId)) === 'v2') {
      try {
        const ranked = await this.engine.recommendWorkersForEmployer(
          profileId,
          topN,
          { exclude: contactedIds },
        );
        if (ranked.length > 0) {
          return {
            hits: ranked.map((r) => ({ id: r.id, score: r.score })),
            engine: 'v2',
          };
        }
      } catch (err) {
        this.logger.warn(`v2 worker ranker failed for ${profileId}`, err);
      }
    }
    return {
      hits:
        (await this.matching.findMatchingWorkersForEmployerProfile(
          profileId,
          topN + contactedIds.size,
        )) ?? [],
      engine: 'legacy',
    };
  }

  private async employerCategoryIds(employerId: string): Promise<string[]> {
    const rows = await this.prisma.jobOffer.findMany({
      where: {
        employer_id: employerId,
        deleted_at: null,
        category_id: { not: null },
      },
      select: { category_id: true },
      distinct: ['category_id'],
    });
    return rows
      .map((r) => r.category_id)
      .filter((id): id is string => id !== null);
  }

  private async eligibleWorkerHits(
    categoryIds: string[],
    contactedIds: Set<string>,
    take: number,
  ): Promise<{ id: string; score: number }[]> {
    const fees = await this.systemConfig.getFees();
    const rows = await this.prisma.profile.findMany({
      where: {
        profile_type: ProfileType.WORKER,
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        deleted_at: null,
        reliability_score: { gte: fees.reliabilityScoreMin },
        ...(contactedIds.size > 0 ? { id: { notIn: [...contactedIds] } } : {}),
        ...(categoryIds.length > 0
          ? { categories: { some: { category_id: { in: categoryIds } } } }
          : {}),
      },
      orderBy: [{ reliability_score: 'desc' }, { rating_avg: 'desc' }],
      take,
      select: { id: true },
    });
    return rows.map((r) => ({ id: r.id, score: 0 }));
  }

  @Get('worker-feed/:workerId')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Recommended worker detail (+ contact fee)',
  })
  @ApiResponse({ status: 200, description: 'Worker detail' })
  @ApiResponse({ status: 404, description: 'Worker not found' })
  async workerDetail(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId') workerId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);

    const [hydrated, recommendationFee, walletBalance] = await Promise.all([
      this.hydrate([{ id: workerId, score: 0 }], { skipEligibility: true }),
      this.systemConfig.getRecommendationContactFee(),
      this.wallet.getProfileWalletBalance(profileId),
    ]);
    const worker = hydrated[0];
    if (!worker) {
      throw new NotFoundException('Travailleur introuvable');
    }

    // Workers who predate slug-on-signup have none, because it used to be
    // minted only on the first realization upload — so the employer saw no
    // "Voir le portfolio" at all. `ensurePortfolioSlug` exists for exactly this
    // and is idempotent. A failure leaves the button hidden, which is a far
    // smaller problem than a detail page that will not load.
    if (!worker.portfolioSlug) {
      worker.portfolioSlug = await this.portfolio
        .ensurePortfolioSlug(workerId)
        .catch((err) => {
          this.logger.warn(
            `Could not mint a portfolio slug for worker=${workerId}`,
            err,
          );
          return null;
        });
    }

    void this.interactionEvents.record({
      actorId: profileId,
      actorType: InteractionActor.EMPLOYER,
      kind: InteractionKind.PROFILE_VIEW,
      objectType: InteractionObject.WORKER_PROFILE,
      objectId: workerId,
      source: InteractionSource.SERVER,
      surface: 'worker_detail',
      requestId: req.requestId,
    });

    return { worker, recommendationFee, walletBalance };
  }

  @Post('recommended-workers/:workerId/contact/pay-wallet')
  @UseGuards(ActiveProfileGuard, KycVerifiedGuard)
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Pay a recommended worker contact via wallet',
  })
  async payWallet(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId') workerId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    return this.recommendationContact.payWithWallet(profileId, workerId);
  }

  @Post('recommended-workers/:workerId/contact/pay-mobile')
  @UseGuards(ActiveProfileGuard, KycVerifiedGuard)
  @ApiOperation({
    summary:
      '[Mobile/EMPLOYER] Create a mobile-money payment for a recommended worker contact',
  })
  async payMobile(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId') workerId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertEmployer(profileId);
    return this.recommendationContact.createMobilePaymentUrl(
      profileId,
      workerId,
    );
  }

  @Get('worker-search')
  @ApiOperation({
    summary:
      '[Mobile/EMPLOYER] Search all workers (name/description + filters)',
  })
  @ApiResponse({ status: 200, description: 'Paginated worker search results' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async workerSearch(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('minReliability') minReliability?: string,
    @Query('minRating') minRating?: string,
    @Query('city') city?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<{ items: RecommendedWorker[]; total: number }> {
    await this.assertEmployer(req.user.profileId);

    const take = this.parseLimit(pageSize, 20, 100);
    const pageNum = Math.max(0, Number.parseInt(page ?? '0', 10) || 0);
    const skip = pageNum * take;

    let where: Prisma.ProfileWhereInput = {
      profile_type: ProfileType.WORKER,
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
      deleted_at: null,
    };
    if (categoryId) {
      where.categories = { some: { category_id: categoryId } };
    }
    const rel = Number(minReliability);
    if (minReliability && Number.isFinite(rel)) {
      where.reliability_score = { gte: rel };
    }
    const rating = Number(minRating);
    if (minRating && Number.isFinite(rating)) {
      where.rating_avg = { gte: rating };
    }
    // Structured `city` first, free-text `address` as the fallback.
    where = withCityFilter(where, city);

    const term = q?.trim();
    if (term) {
      const tokens = term.split(/\s+/).filter(Boolean);
      where.AND = tokens.map((tok) => ({
        OR: [
          { first_name: { contains: tok, mode: 'insensitive' } },
          { last_name: { contains: tok, mode: 'insensitive' } },
          { description: { contains: tok, mode: 'insensitive' } },
        ],
      }));
    }

    const [profiles, total] = await Promise.all([
      this.prisma.profile.findMany({
        where,
        select: WORKER_SELECT,
        skip,
        take,
        orderBy: [{ reliability_score: 'desc' }, { rating_avg: 'desc' }],
      }),
      this.prisma.profile.count({ where }),
    ]);

    const ids = profiles.map((p) => p.id);
    const endCounts =
      ids.length === 0
        ? []
        : await this.prisma.application.groupBy({
            by: ['worker_id'],
            where: { worker_id: { in: ids }, status: 'END' },
            _count: { _all: true },
          });
    const endById = new Map(endCounts.map((c) => [c.worker_id, c._count._all]));

    const items = profiles.map((p) =>
      this.toCard(p, endById.get(p.id) ?? 0, 0),
    );
    return { items, total };
  }

  // --- helpers ---

  private async hydrate(
    hits: { id: string; score: number }[],
    opts: { skipEligibility?: boolean } = {},
  ): Promise<RecommendedWorker[]> {
    if (hits.length === 0) return [];
    const ids = hits.map((h) => h.id);

    const where = opts.skipEligibility
      ? { id: { in: ids } }
      : {
          id: { in: ids },
          // Archiving a profile only writes `deleted_at` — it leaves `status`
          // and `verification_status` untouched (`bulkSoftDeleteProfiles`). The
          // SQL fallback tiers filter on it, but tier 1's ids come from Qdrant,
          // where a point outlives the profile until the next sweep. Without
          // this an archived worker keeps being recommended, and the employer
          // pays a contact fee to reach someone who is gone.
          deleted_at: null,
          status: 'ACTIVE' as const,
          verification_status: 'VERIFIED' as const,
          reliability_score: {
            gte: (await this.systemConfig.getFees()).reliabilityScoreMin,
          },
        };

    const [profiles, endCounts] = await Promise.all([
      this.prisma.profile.findMany({ where, select: WORKER_SELECT }),
      this.prisma.application.groupBy({
        by: ['worker_id'],
        where: { worker_id: { in: ids }, status: 'END' },
        _count: { _all: true },
      }),
    ]);

    const endById = new Map(endCounts.map((c) => [c.worker_id, c._count._all]));
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const scoreById = new Map(hits.map((h) => [h.id, h.score]));

    return ids
      .map((id) => byId.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) =>
        this.toCard(p, endById.get(p.id) ?? 0, scoreById.get(p.id) ?? 0),
      );
  }

  private toCard(
    p: {
      id: string;
      first_name: string;
      last_name: string;
      avatar_url: string | null;
      reliability_score: number | null;
      rating_avg: number | null;
      rating_count: number;
      description: string | null;
      portfolio_slug: string | null;
      address?: string | null;
      verification_status?: string | null;
      categories: { category: { name: string } | null }[];
    },
    completedMissions: number,
    score: number,
  ): RecommendedWorker {
    return {
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      avatarUrl: p.avatar_url,
      reliabilityScore: p.reliability_score,
      ratingAvg: p.rating_avg,
      ratingCount: p.rating_count,
      categoryName: p.categories[0]?.category?.name ?? null,
      categoryNames: p.categories
        .map((c) => c.category?.name)
        .filter((n): n is string => Boolean(n)),
      description: p.description,
      address: p.address ?? null,
      isVerified: p.verification_status === VerificationStatus.VERIFIED,
      completedMissions,
      portfolioSlug: p.portfolio_slug,
      score,
    };
  }

  private parseLimit(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n <= 0) return fallback;
    return Math.min(n, max);
  }

  private async assertEmployer(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== ProfileType.EMPLOYER) {
      throw new ForbiddenException('Réservé aux employeurs');
    }
  }
}
