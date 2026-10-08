import type { Logger } from '@nestjs/common';
import type { EngineRolloutService } from '../recommendation-engine/engine-rollout.service';
import type { RecommendationEngineService } from '../recommendation-engine/recommendation-engine.service';
import type { MatchingService } from './matching.service';

export type RankedWorkerRef = {
  id: string;
  score: number;
  /** Fit for display; null/absent when there is no fit evidence. */
  matchScore?: number | null;
};

export type RankWorkersDeps = {
  matching: Pick<MatchingService, 'findMatchingWorkersForJob'>;
  engine: Pick<RecommendationEngineService, 'recommendWorkersForJobOffer'>;
  rollout: Pick<EngineRolloutService, 'versionFor'>;
  logger?: Pick<Logger, 'warn'>;
};

export type RankWorkersOptions = {
  limit: number;
  minScore: number;
  /**
   * Read lazily: only the v2 ranker takes it, so the legacy path never pays
   * for the config lookup.
   */
  requireVerified: () => Promise<boolean>;
};

/**
 * The workers worth putting in front of someone for one offer, on whichever
 * engine the offer's employer is bucketed onto.
 *
 * Shared by the WhatsApp job fan-out (JobNotificationService) and the agent
 * app's suggested candidates, so a worker an agent is told to call is one the
 * notification would have reached — two rankers would drift apart.
 *
 * Bucketed by employer rather than by worker: bucketing per worker would split
 * a single offer's ranking across both engines, and any comparison of
 * conversion between the two would then be measuring a mixture of itself.
 */
export async function rankWorkersForOffer(
  deps: RankWorkersDeps,
  offer: { id: string; employer_id: string },
  opts: RankWorkersOptions,
): Promise<RankedWorkerRef[]> {
  if ((await deps.rollout.versionFor(offer.employer_id)) === 'v2') {
    try {
      // No fallback on an empty result, unlike the feed controllers. There an
      // empty list is a bug; here it is the whole point of `keepAtLeast: 0`,
      // and falling through would restore the floored threshold this exists
      // to escape. Only a throw falls back.
      return await deps.engine.recommendWorkersForJobOffer(
        offer.id,
        opts.limit,
        {
          minScore: opts.minScore,
          keepAtLeast: 0,
          explore: false,
          strictCategory: true,
          requireVerified: await opts.requireVerified(),
        },
      );
    } catch (err) {
      deps.logger?.warn(
        `v2 ranking failed for offer ${offer.id}, falling back to legacy`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Legacy keeps its caller-side threshold: its own `applyThreshold` is
  // floored, so it returns its best few however bad they are.
  const ranked = await deps.matching.findMatchingWorkersForJob(
    offer.id,
    opts.limit,
  );
  return ranked.filter((w) => w.score >= opts.minScore);
}
