import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import {
  APPLICATION_ACCEPTED_EVENT,
  type ApplicationAcceptedPayload,
} from '../../common/events/application-accepted.event';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { QdrantService } from '../qdrant/qdrant.service';
import { spreadSimilarity } from '../recommendation-engine/scoring';
import type { SimilarHireStep } from './notification-catalog';
import {
  notificationDedupeKey,
  notifyProfile,
} from './profile-notification.events';

/** Workers told per hire. */
export const NUDGES_PER_HIRE = 10;
/** Once a week per worker, however many similar people are hired. */
export const NUDGE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
/** Spread similarity a candidate must reach when vectors exist. */
export const MIN_SIMILARITY = 0.4;
/** Below this a description reads as unfinished. */
export const MIN_DESCRIPTION_LENGTH = 40;
/** Candidates looked at before similarity ranking. */
const CANDIDATE_POOL = 200;

type Candidate = {
  id: string;
  avatar_url: string | null;
  description: string;
  _count: { portfolio_items: number };
};

/**
 * The one step that would raise this profile, or null when it is complete.
 * Photo first — it is what an employer sees first on a card — then the
 * description, then the portfolio.
 */
export function missingStep(c: {
  avatarUrl: string | null;
  description: string | null;
  portfolioItems: number;
}): SimilarHireStep | null {
  if (!c.avatarUrl) return 'PHOTO';
  if ((c.description ?? '').trim().length < MIN_DESCRIPTION_LENGTH)
    return 'DESCRIPTION';
  if (c.portfolioItems === 0) return 'PORTFOLIO';
  return null;
}

/**
 * « Des profils comme le vôtre sont recrutés ».
 *
 * When a worker is hired, the few workers most like them — same trade, same
 * area, similar profile — who are still missing something get one in-app
 * notification naming that one thing. The point is the step, not the news:
 * a hire is private, so nobody is named, and a complete profile is left alone.
 *
 * Only verified, active workers: an unverified one cannot apply yet, and
 * identity is checked by the team, not something they can act on from here.
 * Workers who opted out of marketing are skipped — this is a nudge, not a
 * service message.
 */
@Injectable()
export class SimilarHireNudgeService {
  private readonly logger = new Logger(SimilarHireNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly events: EventEmitter2,
  ) {}

  @OnEvent(APPLICATION_ACCEPTED_EVENT, { async: true })
  async onAccepted(payload: ApplicationAcceptedPayload): Promise<void> {
    try {
      await this.nudge(payload.workerId, payload.jobOfferId);
    } catch (err) {
      this.logger.error(
        `similar-hire nudge failed for application ${payload.applicationId}`,
        err,
      );
    }
  }

  /** Returns how many workers were nudged (before dedupe). */
  async nudge(hiredWorkerId: string, jobOfferId: string): Promise<number> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        category_id: true,
        city: true,
        country_code: true,
        category: { select: { name: true } },
      },
    });
    if (!offer?.category_id || !offer.category) return 0;

    const base = {
      id: { not: hiredWorkerId },
      profile_type: ProfileType.WORKER,
      status: AccountStatus.ACTIVE,
      verification_status: VerificationStatus.VERIFIED,
      deleted_at: null,
      marketing_opt_out_at: null,
      categories: { some: { category_id: offer.category_id } },
    };
    const select = {
      id: true,
      avatar_url: true,
      description: true,
      _count: { select: { portfolio_items: true } },
    } as const;

    // Same city first; the whole country when the city has nobody to tell.
    let pool: Candidate[] = offer.city
      ? await this.prisma.profile.findMany({
          where: { ...base, city: offer.city },
          select,
          orderBy: { last_login_at: { sort: 'desc', nulls: 'last' } },
          take: CANDIDATE_POOL,
        })
      : [];
    if (pool.length === 0 && offer.country_code) {
      pool = await this.prisma.profile.findMany({
        where: { ...base, country_code: offer.country_code },
        select,
        orderBy: { last_login_at: { sort: 'desc', nulls: 'last' } },
        take: CANDIDATE_POOL,
      });
    }

    const incomplete = pool
      .map((c) => ({
        id: c.id,
        step: missingStep({
          avatarUrl: c.avatar_url,
          description: c.description,
          portfolioItems: c._count.portfolio_items,
        }),
      }))
      .filter(
        (c): c is { id: string; step: SimilarHireStep } => c.step !== null,
      );
    if (incomplete.length === 0) return 0;

    const chosen = await this.mostSimilar(hiredWorkerId, incomplete);

    for (const c of chosen) {
      notifyProfile(this.events, {
        recipientId: c.id,
        input: {
          type: 'SIMILAR_PROFILE_HIRED',
          categoryName: offer.category.name,
          city: offer.city,
          step: c.step,
        },
        dedupeKey: notificationDedupeKey('similar-hire', c.id),
        dedupeTtlSeconds: NUDGE_COOLDOWN_SECONDS,
      });
    }
    return chosen.length;
  }

  /**
   * The candidates closest to the hired worker. With vectors: ranked by
   * similarity, those under MIN_SIMILARITY dropped. Without (embeddings off,
   * the hired worker not indexed): the trade-and-area order, which is
   * already a reasonable "people like them".
   */
  private async mostSimilar<T extends { id: string }>(
    hiredWorkerId: string,
    candidates: T[],
  ): Promise<T[]> {
    let sims = new Map<string, number>();
    try {
      sims = await this.qdrant.similarityToPoint(
        COLLECTIONS.WORKERS,
        hiredWorkerId,
        COLLECTIONS.WORKERS,
        candidates.map((c) => c.id),
      );
    } catch (err) {
      this.logger.warn(`similarity lookup failed: ${String(err)}`);
    }
    if (sims.size === 0) return candidates.slice(0, NUDGES_PER_HIRE);

    return candidates
      .map((c) => ({ c, sim: spreadSimilarity(sims.get(c.id) ?? 0) }))
      .filter((x) => sims.has(x.c.id) && x.sim >= MIN_SIMILARITY)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, NUDGES_PER_HIRE)
      .map((x) => x.c);
  }
}
