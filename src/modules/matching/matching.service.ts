import { Injectable, Logger } from '@nestjs/common';
import { jobLocationLabel } from '../../common/utils/job-location.util';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { COLLECTIONS, INDEX_SCHEMA_VERSION } from '../qdrant/qdrant.config';

const COLLECTION_WORKERS = COLLECTIONS.WORKERS;
const COLLECTION_JOBS = COLLECTIONS.JOBS;
const COLLECTION_EMPLOYERS = COLLECTIONS.EMPLOYERS;

// Re-ranking weights. These are RELATIVE — every score is divided by the sum of
// the weights actually applied, so `score` is always on [0,1] and a threshold
// means the same thing however these are tuned.
const W_VECTOR = 0.6;
const W_RELIABILITY = 0.2;
const W_RECENCY = 0.1;
const W_CATEGORY_EXACT = 0.1;

/** Multiplier applied to a candidate the user already rejected or cancelled. */
const NEGATIVE_HISTORY_MULTIPLIER = 0.3;

// Negative signal: only exclude category if worker cancelled/rejected > this many times
const NEGATIVE_CATEGORY_THRESHOLD = 2;

// Max results per category for diversity
const MAX_PER_CATEGORY_JOBS = 3;
const MAX_PER_CATEGORY_WORKERS = 5;

export { NEGATIVE_HISTORY_MULTIPLIER };

interface ScoredHit {
  id: string;
  score: number;
}

interface ScoredHitWithCategory extends ScoredHit {
  categoryId: string | null;
}

function qdrantPayloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' ? v : undefined;
}

function mapSearchHitsToScoredIds(
  results: Array<{
    id: string | number;
    score: number;
    payload: Record<string, unknown> | null;
  }>,
  payloadKey: string,
): ScoredHit[] {
  const out: ScoredHit[] = [];
  for (const r of results) {
    const id = qdrantPayloadString(r.payload, payloadKey);
    if (id !== undefined) out.push({ id, score: r.score });
  }
  return out;
}

/**
 * The geo half of every payload, normalized so a filter can match on it.
 *
 * Country is upper-cased and city lower-cased because these are compared with
 * Qdrant `match`, which is exact — `Brazzaville` and `brazzaville` are two
 * different values to it, and the columns are free enough that both occur.
 *
 * A missing value is written as an empty string rather than omitted. Qdrant has
 * no "field is null" match, and a `must` clause on an absent key excludes the
 * point outright, so omitting it would make every ungeocoded profile invisible
 * the moment any geo filter is applied. An empty string is a value that can be
 * matched, counted, and deliberately allowed through.
 */
function geoPayload(place: {
  country_code?: string | null;
  city?: string | null;
}): { countryCode: string; city: string } {
  return {
    countryCode: place.country_code?.trim().toUpperCase() ?? '',
    city: place.city?.trim().toLowerCase() ?? '',
  };
}

/**
 * Which rows `reindexPending` should rewrite, in order of how wide the net is.
 *
 * Shared verbatim by the job, worker and employer queries — they differ only in
 * the filters layered on top, and letting the staleness rule drift between them
 * is how two of the three would quietly stop being reclaimed.
 */
function pendingWhere(
  schemaChanged: boolean,
  enabledAt: Date | null,
): Record<string, unknown> {
  // Everything: the payload shape itself moved, so a correct stamp says nothing
  // about whether the point carries the fields filters now need.
  if (schemaChanged) return {};
  // Never indexed, or stamped by the disabled-path bookkeeping before
  // embeddings came back on.
  if (enabledAt) {
    return {
      OR: [
        { vector_indexed_at: null },
        { vector_indexed_at: { lt: enabledAt } },
      ],
    };
  }
  return { vector_indexed_at: null };
}

function computeReliabilityBucket(score: number | null | undefined): string {
  const s = score ?? 100;
  if (s >= 90) return 'Excellent';
  if (s >= 70) return 'Fiable';
  return 'Faible';
}

function computeAmountBucket(
  amount: { toNumber?: () => number } | number | null | undefined,
): string {
  if (amount == null) return 'inconnu';
  const n = typeof amount === 'number' ? amount : (amount.toNumber?.() ?? 0);
  if (n <= 0) return 'inconnu';
  if (n < 5000) return 'petit budget';
  if (n <= 20000) return 'budget moyen';
  return 'budget élevé';
}

function computeRecencyFactor(createdAt: Date): number {
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
  return Math.max(0.1, 1.0 - ageHours / 168); // 168 = 7 days in hours
}

/**
 * Converts a retrieval position into a calibrated [0,1] relevance term.
 *
 * Retrieval gives us an ordering, not a similarity: hybrid search returns an RRF
 * fusion score (`Σ 1/(60+rank)`, max ≈0.033 for a doc ranked first in both
 * prefetches). Multiplying that by a weight makes the semantic term ~2% of the
 * total and puts any absolute threshold out of reach. Position in the result set
 * is the only honest signal the fusion gives us, so use it directly.
 */
export function rankRelevance(rank: number, total: number): number {
  if (total <= 1) return 1;
  return 1 - rank / (total - 1);
}

/**
 * Weighted mean over the terms that are actually available, divided by ΣW.
 *
 * Terms that don't apply to an entity must be OMITTED, not passed as a neutral
 * constant — feeding `0.5` for "reliability of a job offer" adds a fixed floor to
 * every score, which is what made the old thresholds unreachable and made
 * downranking impossible.
 */
export function weightedMean(
  terms: { value: number; weight: number }[],
): number {
  const totalWeight = terms.reduce((s, t) => s + t.weight, 0);
  if (totalWeight <= 0) return 0;
  const sum = terms.reduce((s, t) => s + t.value * t.weight, 0);
  return Math.min(1, Math.max(0, sum / totalWeight));
}

/**
 * Drops candidates below `minScore`, but never below `keepAtLeast` results.
 *
 * A relevance threshold must not be able to empty a feed. A misconfigured or
 * miscalibrated threshold previously did exactly that, silently, on three code
 * paths — so the floor is enforced structurally rather than by convention.
 */
export function applyThreshold<T extends { score: number }>(
  ranked: T[],
  minScore: number,
  keepAtLeast: number,
): T[] {
  const passing = ranked.filter((r) => r.score >= minScore);
  return passing.length >= Math.min(keepAtLeast, ranked.length)
    ? passing
    : ranked.slice(0, Math.min(keepAtLeast, ranked.length));
}

function diversifyByCategory(
  items: ScoredHitWithCategory[],
  maxPerCategory: number,
  targetTotal: number,
): ScoredHit[] {
  const counts = new Map<string, number>();
  const output: ScoredHit[] = [];
  for (const item of items) {
    const cat = item.categoryId ?? '__none__';
    const count = counts.get(cat) ?? 0;
    if (count < maxPerCategory) {
      output.push({ id: item.id, score: item.score });
      counts.set(cat, count + 1);
      if (output.length >= targetTotal) break;
    }
  }
  return output;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  // ── Text builders ──────────────────────────────────────────────────────────

  private buildWorkerText(profile: {
    first_name: string;
    last_name: string;
    description: string | null;
    address: string | null;
    reliability_score?: number | null;
    categories?: Array<{
      category: { name: string; description: string | null };
    }>;
    applications?: Array<{
      job_offer: { title: string; category: { name: string } | null };
    }>;
    completed_count?: number;
    total_terminal_count?: number;
    rejected_categories?: string[];
    portfolio_items?: Array<{ title: string; description: string | null }>;
  }): string {
    const parts: string[] = [
      `${profile.first_name} ${profile.last_name}`.trim(),
    ];

    // Categories
    if (profile.categories && profile.categories.length > 0) {
      const names = profile.categories.map((pc) => pc.category.name).join(', ');
      const descriptions = profile.categories
        .map((pc) => pc.category.description)
        .filter(Boolean)
        .join(', ');
      parts.push(names);
      if (descriptions) parts.push(descriptions);
    }

    // Reliability bucket
    const bucket = computeReliabilityBucket(profile.reliability_score);
    if (bucket !== 'Faible') parts.push(`Score fiabilité: ${bucket}`);

    // Completion stats
    const completedCount = profile.completed_count ?? 0;
    if (completedCount > 0) {
      parts.push(`Travaux complétés: ${completedCount}`);
    }
    if (
      profile.total_terminal_count != null &&
      profile.total_terminal_count > 0 &&
      completedCount > 0
    ) {
      const rate = Math.round(
        (completedCount / profile.total_terminal_count) * 100,
      );
      parts.push(`Taux de réussite: ${rate}%`);
    }

    // Profile text
    if (profile.description) parts.push(profile.description);
    if (profile.address) parts.push(profile.address);

    // Accepted/completed job history
    if (profile.applications && profile.applications.length > 0) {
      const jobTitles = profile.applications
        .map((a) => a.job_offer.title)
        .join(', ');
      const jobCategories = [
        ...new Set(
          profile.applications
            .map((a) => a.job_offer.category?.name)
            .filter(Boolean),
        ),
      ].join(', ');
      parts.push(`Travaux effectués: ${jobTitles}`);
      if (jobCategories) parts.push(`Domaines travaillés: ${jobCategories}`);
    }

    // Portfolio realizations (worker showcase)
    if (profile.portfolio_items && profile.portfolio_items.length > 0) {
      const realizations = profile.portfolio_items
        .map((p) => (p.description ? `${p.title} — ${p.description}` : p.title))
        .join('; ');
      if (realizations) parts.push(`Réalisations: ${realizations}`);
    }

    // Negative signal: categories the worker avoids
    if (profile.rejected_categories && profile.rejected_categories.length > 0) {
      parts.push(`Ne souhaite pas: ${profile.rejected_categories.join(', ')}`);
    }

    return parts.join('. ');
  }

  private buildJobText(job: {
    title: string;
    description: string;
    address: string | null;
    amount?: { toNumber?: () => number } | number | null;
    payment_flow?: string | null;
    quantity?: number | null;
    note?: string | null;
    category?: { name: string; description: string | null } | null;
    employerCategories?: Array<{ name: string; description: string | null }>;
  }): string {
    // The embedding text: a remote job contributes its label rather than a
    // hole, so "en ligne" is itself searchable.
    const parts: string[] = [job.title, job.description, jobLocationLabel(job)];

    if (job.category?.name) {
      parts.push(job.category.name);
      if (job.category.description) parts.push(job.category.description);
    } else if (job.employerCategories && job.employerCategories.length > 0) {
      for (const cat of job.employerCategories) {
        parts.push(cat.name);
        if (cat.description) parts.push(cat.description);
      }
    }

    // Amount
    if (job.amount != null) {
      const n =
        typeof job.amount === 'number'
          ? job.amount
          : (job.amount.toNumber?.() ?? 0);
      if (n > 0) {
        parts.push(`Rémunération: ${n.toLocaleString('fr-FR')} FCFA`);
        parts.push(computeAmountBucket(n));
      }
    }

    // Payment flow in French
    const flowLabels: Record<string, string> = {
      HOURLY: "paiement à l'heure",
      DAILY: 'paiement journalier',
      MONTHLY: 'paiement mensuel',
    };
    if (job.payment_flow && flowLabels[job.payment_flow]) {
      parts.push(flowLabels[job.payment_flow]);
    }

    // Quantity
    if (job.quantity != null && job.quantity > 1) {
      parts.push(`Nombre de postes: ${job.quantity}`);
    }

    return parts.join('. ');
  }

  private buildEmployerText(profile: {
    first_name: string;
    last_name: string;
    description: string | null;
    address: string | null;
    categories?: Array<{
      category: { name: string; description: string | null };
    }>;
  }): string {
    const parts: string[] = [
      `${profile.first_name} ${profile.last_name}`.trim(),
    ];
    if (profile.categories && profile.categories.length > 0) {
      const names = profile.categories.map((pc) => pc.category.name).join(', ');
      const descriptions = profile.categories
        .map((pc) => pc.category.description)
        .filter(Boolean)
        .join(', ');
      parts.push(names);
      if (descriptions) parts.push(descriptions);
    }
    if (profile.description) parts.push(profile.description);
    if (profile.address) parts.push(profile.address);
    return parts.join('. ');
  }

  // ── Re-ranking helpers ──────────────────────────────────────────────────────

  private async reRankWorkers(
    hits: ScoredHit[],
    jobCategoryId: string | null,
  ): Promise<ScoredHitWithCategory[]> {
    if (hits.length === 0) return [];
    const workerIds = hits.map((h) => h.id);
    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: workerIds } },
      select: {
        id: true,
        reliability_score: true,
        categories: { select: { category_id: true } },
      },
    });
    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    // `hits` arrives in descending retrieval order, so the index IS the rank.
    // No recency term: a worker profile has no meaningful freshness, and passing a
    // constant for it would just add a fixed floor to every score.
    const ranked: ScoredHitWithCategory[] = hits.map((hit, rank) => {
      const profile = profileMap.get(hit.id);
      const matchesJobCategory =
        jobCategoryId != null &&
        (profile?.categories.some((c) => c.category_id === jobCategoryId) ??
          false);

      const score = weightedMean([
        { value: rankRelevance(rank, hits.length), weight: W_VECTOR },
        {
          value: (profile?.reliability_score ?? 100) / 100,
          weight: W_RELIABILITY,
        },
        { value: matchesJobCategory ? 1 : 0, weight: W_CATEGORY_EXACT },
      ]);

      const workerCategoryId = matchesJobCategory
        ? jobCategoryId
        : (profile?.categories[0]?.category_id ?? null);
      return { id: hit.id, score, categoryId: workerCategoryId };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }

  private async reRankJobs(
    hits: ScoredHit[],
    workerId: string,
    workerCategoryIds: string[],
  ): Promise<ScoredHitWithCategory[]> {
    if (hits.length === 0) return [];
    const jobIds = hits.map((h) => h.id);

    const [jobs, negativeApplications] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where: { id: { in: jobIds } },
        select: { id: true, created_at: true, category_id: true },
      }),
      this.prisma.application.findMany({
        where: {
          worker_id: workerId,
          status: { in: ['REJECTED', 'CANCELLED'] },
          job_offer_id: { in: jobIds },
        },
        select: { job_offer_id: true },
      }),
    ]);

    const jobMap = new Map(jobs.map((j) => [j.id, j]));
    const negativeJobIds = new Set(
      negativeApplications.map((a) => a.job_offer_id),
    );

    // `hits` arrives in descending retrieval order, so the index IS the rank.
    // No reliability term: that's a worker attribute, not a property of an offer.
    const ranked: ScoredHitWithCategory[] = hits.map((hit, rank) => {
      const job = jobMap.get(hit.id);
      const matchesWorkerCategory =
        job?.category_id != null && workerCategoryIds.includes(job.category_id);

      const relevance = weightedMean([
        { value: rankRelevance(rank, hits.length), weight: W_VECTOR },
        {
          // A missing job is a stale index entry; treat it as maximally old
          // rather than neutral so it sinks instead of floating.
          value: job ? computeRecencyFactor(job.created_at) : 0,
          weight: W_RECENCY,
        },
        { value: matchesWorkerCategory ? 1 : 0, weight: W_CATEGORY_EXACT },
      ]);

      // Multiplicative, so it actually suppresses rather than being swamped.
      const score = negativeJobIds.has(hit.id)
        ? relevance * NEGATIVE_HISTORY_MULTIPLIER
        : relevance;

      return { id: hit.id, score, categoryId: job?.category_id ?? null };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }

  // ── Compute negative category IDs for a worker ─────────────────────────────

  private async computeNegativeCategoryIds(
    profileId: string,
  ): Promise<string[]> {
    const [rejectedApps, successfulApps] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          worker_id: profileId,
          status: { in: ['REJECTED', 'CANCELLED'] },
        },
        select: { job_offer: { select: { category_id: true } } },
        orderBy: { created_at: 'desc' },
        take: 50,
      }),
      this.prisma.application.findMany({
        where: {
          worker_id: profileId,
          status: { in: ['ACCEPTED', 'END'] },
        },
        select: { job_offer: { select: { category_id: true } } },
      }),
    ]);

    const successCategoryIds = new Set(
      successfulApps
        .map((a) => a.job_offer.category_id)
        .filter((id): id is string => id != null),
    );

    const rejectionCounts = new Map<string, number>();
    for (const app of rejectedApps) {
      const catId = app.job_offer.category_id;
      if (!catId) continue;
      rejectionCounts.set(catId, (rejectionCounts.get(catId) ?? 0) + 1);
    }

    const negatives: string[] = [];
    for (const [catId, count] of rejectionCounts.entries()) {
      if (
        count >= NEGATIVE_CATEGORY_THRESHOLD &&
        !successCategoryIds.has(catId)
      ) {
        negatives.push(catId);
      }
    }
    return negatives;
  }

  // ── Indexing ────────────────────────────────────────────────────────────────

  async indexWorkerProfile(profileId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) {
      await this.prisma.profile
        .update({
          where: { id: profileId },
          data: { vector_indexed_at: new Date() },
        })
        .catch(() => {
          /* profile may have been deleted */
        });
      return;
    }

    const [profile, completedCount, totalTerminalCount] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: profileId },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          description: true,
          address: true,
          country_code: true,
          city: true,
          profile_type: true,
          reliability_score: true,
          categories: {
            select: {
              category_id: true,
              category: { select: { name: true, description: true } },
            },
          },
          applications: {
            where: { status: { in: ['ACCEPTED', 'END'] } },
            select: {
              job_offer: {
                select: {
                  title: true,
                  category: { select: { name: true } },
                },
              },
            },
            orderBy: { created_at: 'desc' },
            take: 10,
          },
          portfolio_items: {
            select: { title: true, description: true },
            orderBy: { position: 'asc' },
          },
        },
      }),
      this.prisma.application.count({
        where: { worker_id: profileId, status: 'END' },
      }),
      this.prisma.application.count({
        where: {
          worker_id: profileId,
          status: { in: ['ACCEPTED', 'END', 'REJECTED', 'CANCELLED'] },
        },
      }),
    ]);

    if (profile?.profile_type !== 'WORKER') return;

    try {
      const negativeCategoryIds =
        await this.computeNegativeCategoryIds(profileId);

      // Fetch negative category names for embedding text
      const negativeCategoryNames =
        negativeCategoryIds.length > 0
          ? (
              await this.prisma.jobCategory.findMany({
                where: { id: { in: negativeCategoryIds } },
                select: { name: true },
              })
            ).map((c) => c.name)
          : [];

      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildWorkerText({
        ...profile,
        completed_count: completedCount,
        total_terminal_count: totalTerminalCount,
        rejected_categories: negativeCategoryNames,
      });

      const fullName =
        `${profile.first_name} ${profile.last_name}`.trim() || profileId;
      const categoryIds = profile.categories.map((pc) => pc.category_id);
      const categoryNames = profile.categories
        .map((pc) => pc.category.name)
        .join(', ');

      await this.qdrant.upsertHybrid(COLLECTION_WORKERS, profileId, text, {
        profileId,
        firstName: profile.first_name,
        lastName: profile.last_name,
        fullName,
        description: profile.description ?? '',
        address: profile.address ?? '',
        categoryIds,
        categoryName: categoryNames,
        categoryDescription: profile.categories
          .map((pc) => pc.category.description ?? '')
          .filter(Boolean)
          .join(', '),
        profileType: profile.profile_type,
        reliabilityBucket: computeReliabilityBucket(profile.reliability_score),
        reliabilityScore: profile.reliability_score ?? 100,
        rejectedCategoryIds: negativeCategoryIds,
        ...geoPayload(profile),
      });
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { vector_indexed_at: new Date() },
      });
      this.logger.log(`Indexed worker profile ${profileId}`);
    } catch (err) {
      this.logger.error(`Failed to index worker profile ${profileId}`, err);
    }
  }

  async indexJobOffer(jobOfferId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) {
      // Embeddings are turned off platform-wide. Stamp the row so the admin UI
      // stops claiming the job is "pending indexing" forever and the reaper
      // stops re-picking it. When embeddings are re-enabled the operator can
      // run a bulk reindex from the matching controller.
      await this.prisma.jobOffer
        .update({
          where: { id: jobOfferId },
          data: { vector_indexed_at: new Date() },
        })
        .catch(() => {
          /* row may have been deleted; safe to ignore */
        });
      return;
    }

    const job = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        employer_id: true,
        title: true,
        description: true,
        address: true,
        country_code: true,
        city: true,
        amount: true,
        payment_flow: true,
        quantity: true,
        note: true,
        status: true,
        created_at: true,
        category_id: true,
        category: { select: { name: true, description: true } },
        // Falls back to where the employer is when the offer names no place of
        // its own — the same precedence `toCandidate` applies in the v2 ranker.
        employer: { select: { country_code: true, city: true } },
      },
    });

    if (!job) return;

    // When the job has no explicit category, fall back to all of the employer's
    // categories so the embedding text carries full domain signal for matching.
    let employerCategories: Array<{
      name: string;
      description: string | null;
    }> = [];
    if (!job.category_id && job.employer_id) {
      const employer = await this.prisma.profile.findUnique({
        where: { id: job.employer_id },
        select: {
          categories: {
            select: { category: { select: { name: true, description: true } } },
          },
        },
      });
      employerCategories = employer?.categories.map((pc) => pc.category) ?? [];
    }

    try {
      await this.qdrant.ensureCollection(COLLECTION_JOBS);
      const text = this.buildJobText({ ...job, employerCategories });
      await this.qdrant.upsertHybrid(COLLECTION_JOBS, jobOfferId, text, {
        jobOfferId: job.id,
        title: job.title,
        description: job.description,
        address: job.address,
        amount: job.amount != null ? job.amount.toString() : '',
        amountBucket: computeAmountBucket(job.amount),
        payment_flow: job.payment_flow ?? '',
        quantity: job.quantity,
        note: job.note ?? '',
        categoryId: job.category_id ?? '',
        categoryName: job.category?.name ?? '',
        categoryDescription: job.category?.description ?? '',
        status: job.status,
        createdAt: job.created_at.toISOString(),
        ...geoPayload({
          country_code: job.country_code ?? job.employer?.country_code,
          city: job.city ?? job.employer?.city,
        }),
      });
      await this.prisma.jobOffer.update({
        where: { id: jobOfferId },
        data: { vector_indexed_at: new Date() },
      });
      this.logger.log(`Indexed job offer ${jobOfferId}`);
    } catch (err) {
      this.logger.error(`Failed to index job offer ${jobOfferId}`, err);
    }
  }

  async deleteJobFromIndex(jobOfferId: string): Promise<void> {
    try {
      await this.qdrant.deletePoints(COLLECTION_JOBS, [jobOfferId]);
      this.logger.log(`Removed job offer ${jobOfferId} from vector index`);
    } catch (err) {
      this.logger.error(
        `Failed to remove job offer ${jobOfferId} from vector index`,
        err,
      );
    }
  }

  /** Remove a worker profile point from the workers collection. */
  async deleteWorkerFromIndex(profileId: string): Promise<void> {
    await this.qdrant.deletePoints(COLLECTION_WORKERS, [profileId]);
    this.logger.log(`Removed worker profile ${profileId} from workers index`);
  }

  /** Remove an employer profile point from the employers collection. */
  async deleteEmployerFromIndex(profileId: string): Promise<void> {
    await this.qdrant.deletePoints(COLLECTION_EMPLOYERS, [profileId]);
    this.logger.log(
      `Removed employer profile ${profileId} from employers index`,
    );
  }

  // ── Employer profile indexing ───────────────────────────────────────────────

  /**
   * Embed and upsert an employer profile into the employers collection.
   * Gated by feature flag. Used to find matching workers when no job is published yet.
   */
  async indexEmployerProfile(profileId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) {
      await this.prisma.profile
        .update({
          where: { id: profileId },
          data: { vector_indexed_at: new Date() },
        })
        .catch(() => {
          /* profile may have been deleted */
        });
      return;
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        country_code: true,
        city: true,
        profile_type: true,
        categories: {
          select: { category: { select: { name: true, description: true } } },
        },
      },
    });

    if (profile?.profile_type !== 'EMPLOYER') return;

    try {
      await this.qdrant.ensureCollection(COLLECTION_EMPLOYERS);
      const text = this.buildEmployerText(profile);
      await this.qdrant.upsertHybrid(COLLECTION_EMPLOYERS, profileId, text, {
        profileId,
        firstName: profile.first_name,
        lastName: profile.last_name,
        description: profile.description ?? '',
        address: profile.address ?? '',
        categoryIds: profile.categories.map((pc) => pc.category.name),
        ...geoPayload(profile),
      });
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { vector_indexed_at: new Date() },
      });
      this.logger.log(`Indexed employer profile ${profileId}`);
    } catch (err) {
      this.logger.error(`Failed to index employer profile ${profileId}`, err);
    }
  }

  // ── Search / recommendations ───────────────────────────────────────────────

  async findMatchingWorkersForJob(
    jobOfferId: string,
    topN = 20,
  ): Promise<ScoredHit[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return [];

    const job = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        title: true,
        description: true,
        address: true,
        country_code: true,
        city: true,
        category_id: true,
        category: { select: { name: true, description: true } },
        employer: { select: { country_code: true, city: true } },
      },
    });
    if (!job) return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildJobText(job);
      const countryClause = await this.countryMustClause(
        job.country_code ?? job.employer?.country_code,
      );

      // Phase 2: filter workers to those who have this job's category
      let hits: ScoredHit[];
      if (job.category_id) {
        const filter = {
          must: [
            {
              key: 'categoryIds',
              match: { any: [job.category_id] },
            },
            {
              must_not: [
                {
                  key: 'rejectedCategoryIds',
                  match: { any: [job.category_id] },
                },
              ],
            },
            ...countryClause,
          ],
        };
        const results = await this.qdrant.searchHybridWithFilter(
          COLLECTION_WORKERS,
          text,
          filter,
          topN * 2, // fetch more before re-ranking
        );
        hits = mapSearchHitsToScoredIds(results, 'profileId');
      } else if (countryClause.length > 0) {
        const results = await this.qdrant.searchHybridWithFilter(
          COLLECTION_WORKERS,
          text,
          { must: countryClause },
          topN * 2,
        );
        hits = mapSearchHitsToScoredIds(results, 'profileId');
      } else {
        const results = await this.qdrant.searchHybrid(
          COLLECTION_WORKERS,
          text,
          topN * 2,
        );
        hits = mapSearchHitsToScoredIds(results, 'profileId');
      }

      // Phase 3: re-rank
      const reRanked = await this.reRankWorkers(hits, job.category_id ?? null);

      // Phase 4: score threshold — floored so it can never empty the result
      const minScore = await this.systemConfig.getRecommendationMinScore();
      const filtered = applyThreshold(reRanked, minScore, topN);

      // Phase 5: the best `topN`, in rank order.
      //
      // No category diversification here, unlike the employer feed. Retrieval
      // already filtered every candidate to this offer's own category, so they
      // all carry the same one — a per-category cap therefore capped the entire
      // fan-out rather than spreading it, silently limiting a categorised offer
      // to five recipients however many good matches existed and whatever
      // `matching.max_notification_workers` was set to.
      return filtered.slice(0, topN).map(({ id, score }) => ({ id, score }));
    } catch (err) {
      this.logger.error(
        `findMatchingWorkersForJob failed for ${jobOfferId}`,
        err,
      );
      return [];
    }
  }

  async findMatchingJobsForWorker(
    profileId: string,
    topN = 10,
  ): Promise<ScoredHit[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return [];

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
        reliability_score: true,
        categories: {
          select: {
            category_id: true,
            category: { select: { name: true, description: true } },
          },
        },
        applications: {
          where: { status: { in: ['ACCEPTED', 'END'] } },
          select: {
            job_offer: {
              select: {
                title: true,
                category: { select: { name: true } },
              },
            },
          },
          orderBy: { created_at: 'desc' },
          take: 10,
        },
      },
    });
    if (profile?.profile_type !== 'WORKER') return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_JOBS);
      const text = this.buildWorkerText(profile);
      const workerCategoryIds = profile.categories.map((pc) => pc.category_id);

      // Phase 2: filter jobs to categories the worker has
      let hits: ScoredHit[];
      if (workerCategoryIds.length > 0) {
        const filter = {
          must: [
            {
              key: 'categoryId',
              match: { any: workerCategoryIds },
            },
          ],
        };
        const results = await this.qdrant.searchHybridWithFilter(
          COLLECTION_JOBS,
          text,
          filter,
          topN * 3,
        );
        hits = mapSearchHitsToScoredIds(results, 'jobOfferId');
      } else {
        const results = await this.qdrant.searchHybrid(
          COLLECTION_JOBS,
          text,
          topN * 3,
        );
        hits = mapSearchHitsToScoredIds(results, 'jobOfferId');
      }

      // Phase 3: re-rank with recency, category exact match, negative history
      const reRanked = await this.reRankJobs(
        hits,
        profileId,
        workerCategoryIds,
      );

      // Phase 4: score threshold — floored so it can never empty the feed
      const minScore = await this.systemConfig.getRecommendationMinScore();
      const filtered = applyThreshold(reRanked, minScore, topN);

      // Phase 6: diversity then slice
      const diverse = diversifyByCategory(
        filtered,
        MAX_PER_CATEGORY_JOBS,
        topN,
      );
      return diverse;
    } catch (err) {
      this.logger.error(
        `findMatchingJobsForWorker failed for ${profileId}`,
        err,
      );
      return [];
    }
  }

  async findMatchingWorkersForEmployer(
    jobOfferId: string,
    topN = 10,
  ): Promise<ScoredHit[]> {
    return this.findMatchingWorkersForJob(jobOfferId, topN);
  }

  async findMatchingWorkersForEmployerProfile(
    employerProfileId: string,
    topN = 10,
  ): Promise<ScoredHit[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) {
      // Named rather than silent: an empty result here sends the employer feed
      // to its SQL fallback, which serves a plausible list with every score at
      // 0. Callers cannot tell that apart from "no worker matched".
      this.logger.debug(
        `findMatchingWorkersForEmployerProfile: matching.use_embeddings is off, returning no hits for ${employerProfileId}`,
      );
      return [];
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: employerProfileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
        categories: {
          select: { category: { select: { name: true, description: true } } },
        },
      },
    });

    if (profile?.profile_type !== 'EMPLOYER') return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildEmployerText(profile);
      const results = await this.qdrant.searchHybrid(
        COLLECTION_WORKERS,
        text,
        topN * 2,
      );
      const hits = mapSearchHitsToScoredIds(results, 'profileId');
      const reRanked = await this.reRankWorkers(hits, null);
      // Threshold is config-driven (matching.recommendation_min_score) and
      // floored so it can never empty the feed.
      const minScore = await this.systemConfig.getRecommendationMinScore();
      const filtered = applyThreshold(reRanked, minScore, topN);
      return diversifyByCategory(filtered, MAX_PER_CATEGORY_WORKERS, topN);
    } catch (err) {
      this.logger.error(
        `findMatchingWorkersForEmployerProfile failed for ${employerProfileId}`,
        err,
      );
      return [];
    }
  }

  /**
   * A country constraint for retrieval, or nothing at all.
   *
   * Retrieval is the only place this can be enforced usefully. Proximity is
   * already a scoring term, but a score cannot rescue a candidate the vector
   * search never returned, and it cannot stop one being returned either — on
   * the notification path an out-of-country worker that survives into the
   * fan-out costs a paid WhatsApp template and an hour of that person's
   * notification quota, which no amount of post-hoc ranking refunds.
   *
   * Returns an EMPTY clause list in two cases, and both matter:
   *
   * - The index has not been rewritten at the current payload schema. Points
   *   written before `countryCode` existed do not carry the key, and a Qdrant
   *   `must` clause on a key a point lacks excludes that point — so filtering a
   *   half-migrated index would silently return nothing rather than erroring.
   *   Better to keep today's country-blind behaviour until the rewrite lands.
   * - The job has no country. Filtering on `''` would match only the other
   *   ungeocoded workers, which is a narrower and more arbitrary pool than not
   *   filtering at all.
   *
   * Workers with no country of their own are deliberately let through
   * alongside the matching ones: a missing country is unknown, not elsewhere,
   * and excluding them would silently shrink the fan-out in exactly the markets
   * where geocoding is patchy.
   */
  private async countryMustClause(
    countryCode: string | null | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const code = countryCode?.trim().toUpperCase();
    if (!code) return [];

    const storedVersion = await this.systemConfig.getIndexSchemaVersion();
    if (storedVersion !== INDEX_SCHEMA_VERSION) {
      this.logger.debug(
        `Skipping country filter: index at schema ${storedVersion ?? 'unset'}, code expects ${INDEX_SCHEMA_VERSION}`,
      );
      return [];
    }

    return [{ key: 'countryCode', match: { any: [code, ''] } }];
  }

  // ── Pending re-index ────────────────────────────────────────────────────────

  async reindexPending(): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return;

    // A payload change makes every existing point stale regardless of when it
    // was written: the vector is still right, but the payload is missing fields
    // that filters now depend on. Rewriting all of them is the only way those
    // fields ever appear on the back catalogue, so the version mismatch widens
    // the scan to everything for exactly one pass.
    const storedVersion = await this.systemConfig.getIndexSchemaVersion();
    const schemaChanged = storedVersion !== INDEX_SCHEMA_VERSION;

    const enabledAt = await this.systemConfig.getEmbeddingsEnabledAt();
    // A null stamp is the obvious pending case. The second clause is the one
    // that matters after a toggle: while embeddings are off the three indexers
    // stamp `vector_indexed_at` and return WITHOUT writing a vector, so on the
    // way back up every row looks indexed and this scan would find nothing to
    // do — permanently. Anything stamped before embeddings were switched on is
    // therefore bookkeeping, not an index, and has to be redone. A genuine
    // re-index writes a stamp newer than `enabledAt`, so the set drains and the
    // scan settles instead of churning.
    const pending = pendingWhere(schemaChanged, enabledAt);

    if (schemaChanged) {
      this.logger.log(
        `Index payload schema ${storedVersion ?? 'unset'} → ${INDEX_SCHEMA_VERSION}: rewriting every point once`,
      );
    }

    const [jobs, workers, employers] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where: { ...pending, status: { not: 'CANCELLED' } },
        select: { id: true },
      }),
      this.prisma.profile.findMany({
        where: {
          ...pending,
          profile_type: 'WORKER',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
      this.prisma.profile.findMany({
        where: {
          ...pending,
          profile_type: 'EMPLOYER',
          status: 'ACTIVE',
        },
        select: { id: true },
      }),
    ]);

    this.logger.log(
      `reindexPending: ${jobs.length} jobs, ${workers.length} workers, ${employers.length} employers` +
        (enabledAt ? ` (stale cutoff ${enabledAt.toISOString()})` : ''),
    );

    const BATCH_SIZE = 10;
    const batchProcess = async <T extends { id: string }>(
      items: T[],
      fn: (id: string) => Promise<void>,
    ) => {
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.all(
          items.slice(i, i + BATCH_SIZE).map((item) => fn(item.id)),
        );
      }
    };

    await batchProcess(jobs, (id) => this.indexJobOffer(id));
    await batchProcess(workers, (id) => this.indexWorkerProfile(id));
    await batchProcess(employers, (id) => this.indexEmployerProfile(id));

    await this.sweepOrphanedProfilePoints();

    // Recorded only after the whole pass, and only when the pass was the wide
    // one. Each `index*` call swallows its own errors, so a partial rewrite ends
    // here looking successful — but the next scan re-picks whatever still has an
    // old stamp, and marking the version early would cancel that safety net.
    if (schemaChanged) {
      await this.systemConfig.setIndexSchemaVersion(INDEX_SCHEMA_VERSION);
      this.logger.log(
        `Index payload schema now at ${INDEX_SCHEMA_VERSION}; geo filters are live`,
      );
    }
  }

  /**
   * Enforces the invariant that the index holds exactly the profiles eligible to
   * be retrieved: present, not archived, and ACTIVE.
   *
   * Indexing is additive — every path writes points, none removes them — so a
   * profile that stops being eligible keeps its vector and keeps being
   * retrieved. Nothing else can catch this: search only reports what matches, so
   * a point that should not exist is invisible until someone compares the two
   * sides. Reconciling here rather than hooking each delete path also covers
   * rows changed by admin tooling or straight SQL, which a hook never would.
   *
   * Status matters as much as deletion, and is the easier one to miss.
   * `reindexPending` only ever rewrites ACTIVE rows, so a SUSPENDED profile is
   * never revisited: it keeps whatever payload it had when it was suspended,
   * survives every payload migration, and stays retrievable by any search whose
   * filters it happens to satisfy. Removing it is both the correctness fix and
   * what keeps a schema migration honest — otherwise the version marker claims
   * a rewrite that provably did not cover every point.
   *
   * Best-effort by design: this runs at the tail of a scan whose real job is
   * indexing, and a Qdrant fault must not undo work that already succeeded.
   */
  private async sweepOrphanedProfilePoints(): Promise<void> {
    for (const [collection, profileType] of [
      [COLLECTION_WORKERS, 'WORKER'],
      [COLLECTION_EMPLOYERS, 'EMPLOYER'],
    ] as const) {
      try {
        const pointIds = await this.qdrant.listPointIds(collection);
        if (pointIds.length === 0) continue;

        const live = await this.prisma.profile.findMany({
          where: {
            id: { in: pointIds },
            profile_type: profileType,
            deleted_at: null,
            // Mirrors the `status` filter every candidate query already applies,
            // and the one `reindexPending` selects on. A point that cannot
            // legally be recommended has no reason to occupy a retrieval slot.
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        const liveIds = new Set(live.map((p) => p.id));
        const orphans = pointIds.filter((id) => !liveIds.has(id));
        if (orphans.length === 0) continue;

        await this.qdrant.deletePoints(collection, orphans);

        // Clear the stamp on whatever rows survive, so a profile that becomes
        // eligible again is re-indexed. Without this, suspending and then
        // reactivating someone removes their point but leaves a stamp saying it
        // exists — `reindexPending` skips them and they are invisible to search
        // permanently. Rows that are gone or archived simply match nothing.
        await this.prisma.profile.updateMany({
          where: { id: { in: orphans } },
          data: { vector_indexed_at: null },
        });

        this.logger.log(
          `sweepOrphanedProfilePoints: removed ${orphans.length} ineligible point(s) from ${collection}`,
        );
      } catch (err) {
        this.logger.warn(`Orphan sweep failed for ${collection}`, err);
      }
    }
  }
}
