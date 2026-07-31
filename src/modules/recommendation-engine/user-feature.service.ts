import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { temporalWeight } from '../interest-graph/interest-signal.service';
import { haversineKm } from '../../common/services/geocoding/geo.utils';
import { normalizeAffinity, clamp01 } from './scoring';

/** Fewer than this many positives and a category can't be called "rejected". */
const NEGATIVE_CATEGORY_MIN_EVENTS = 2;
/** Bounds on the learned commute tolerance, in km. */
const MIN_DISTANCE_HALF_LIFE_KM = 2;
const MAX_DISTANCE_HALF_LIFE_KM = 25;
export const DEFAULT_DISTANCE_HALF_LIFE_KM = 5;
/** Cap on events replayed per rebuild — protects against a pathological actor. */
const MAX_EVENTS_PER_REBUILD = 2000;

export type UserFeatures = {
  positiveCount: number;
  eventCount: number;
  categoryAffinity: Record<string, number>;
  counterpartyAffinity: Record<string, number>;
  amountBandAffinity: Record<string, number>;
  paymentFlowAffinity: Record<string, number>;
  negativeCategoryIds: string[];
  distanceHalfLifeKm: number;
};

export const EMPTY_FEATURES: UserFeatures = {
  positiveCount: 0,
  eventCount: 0,
  categoryAffinity: {},
  counterpartyAffinity: {},
  amountBandAffinity: {},
  paymentFlowAffinity: {},
  negativeCategoryIds: [],
  distanceHalfLifeKm: DEFAULT_DISTANCE_HALF_LIFE_KM,
};

/**
 * Derives per-user preference features from the interaction log.
 *
 * These are what let two profiles with identical attributes get different feeds
 * even when embeddings are switched off entirely — they are plain Postgres
 * columns, readable by the SQL-only fallback tier.
 *
 * Everything here is a projection: `interaction_profiles` can be dropped and
 * rebuilt from `interaction_events` at any time.
 */
@Injectable()
export class UserFeatureService {
  private readonly logger = new Logger(UserFeatureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Reads the stored projection, falling back to neutral features. */
  async get(profileId: string): Promise<UserFeatures> {
    const row = await this.prisma.interactionProfile.findUnique({
      where: { profile_id: profileId },
    });
    if (!row) return EMPTY_FEATURES;

    return {
      positiveCount: row.positive_count,
      eventCount: row.event_count,
      categoryAffinity: asRecord(row.category_affinity),
      counterpartyAffinity: asRecord(row.counterparty_affinity),
      amountBandAffinity: asRecord(row.amount_band_affinity),
      paymentFlowAffinity: asRecord(row.payment_flow_affinity),
      negativeCategoryIds: row.negative_category_ids,
      distanceHalfLifeKm:
        row.distance_half_life_km ?? DEFAULT_DISTANCE_HALF_LIFE_KM,
    };
  }

  /**
   * Recomputes a profile's features from the event log and persists them.
   *
   * `asOf` exists for offline replay: passing it forbids reading any event at or
   * after that instant. Leaking future events is the mistake that makes an
   * offline evaluation look excellent and the online test disappoint, so the
   * cutoff is a parameter of the query rather than a convention.
   */
  async rebuild(profileId: string, asOf?: Date): Promise<UserFeatures> {
    const events = await this.prisma.interactionEvent.findMany({
      where: {
        actor_id: profileId,
        ...(asOf ? { occurred_at: { lt: asOf } } : {}),
      },
      orderBy: { occurred_at: 'desc' },
      take: MAX_EVENTS_PER_REBUILD,
      select: {
        kind: true,
        weight: true,
        occurred_at: true,
        object_id: true,
        category_id: true,
        counterparty_id: true,
      },
    });

    const features = this.deriveFeatures(events, asOf);
    const distance = await this.learnDistanceTolerance(profileId, asOf);
    const merged: UserFeatures = {
      ...features,
      distanceHalfLifeKm: distance ?? DEFAULT_DISTANCE_HALF_LIFE_KM,
    };

    await this.persist(profileId, merged, events.at(0)?.occurred_at ?? null);
    return merged;
  }

  /**
   * Pure derivation, exposed for testing and for the replay harness.
   *
   * Each event's contribution is its signed weight decayed by age, so a strong
   * signal from six months ago counts for less than a weak one from yesterday.
   */
  deriveFeatures(
    events: {
      kind: string;
      weight: number;
      occurred_at: Date;
      category_id: string | null;
      counterparty_id: string | null;
    }[],
    asOf?: Date,
  ): Omit<UserFeatures, 'distanceHalfLifeKm'> {
    const now = asOf?.getTime() ?? Date.now();
    const categoryPos = new Map<string, number>();
    const categoryNeg = new Map<string, number>();
    const categoryNegEvents = new Map<string, number>();
    const counterparty = new Map<string, number>();
    let positiveCount = 0;

    for (const e of events) {
      // Decay relative to `asOf`, not wall-clock. The previous form —
      // `temporalWeight(new Date(now - (now - occurred_at)))` — cancelled out to
      // plain `temporalWeight(occurred_at)`, so replay measured age from today
      // and dropped anything past the 180-day cliff that was still live then.
      const decay = temporalWeight(
        e.occurred_at,
        undefined,
        asOf ?? new Date(),
      );
      if (decay <= 0) continue;

      const contribution = e.weight * decay;
      if (e.weight > 0) positiveCount++;

      if (e.category_id) {
        if (contribution > 0) {
          categoryPos.set(
            e.category_id,
            (categoryPos.get(e.category_id) ?? 0) + contribution,
          );
        } else if (contribution < 0) {
          categoryNeg.set(
            e.category_id,
            (categoryNeg.get(e.category_id) ?? 0) - contribution,
          );
          categoryNegEvents.set(
            e.category_id,
            (categoryNegEvents.get(e.category_id) ?? 0) + 1,
          );
        }
      }

      if (e.counterparty_id && contribution > 0) {
        counterparty.set(
          e.counterparty_id,
          (counterparty.get(e.counterparty_id) ?? 0) + contribution,
        );
      }
    }

    // A category counts as negative only when it has repeated negatives AND no
    // positive engagement outweighing them. Requiring both means one bad
    // experience — or one lost race — can't lock a worker out of their trade.
    const negativeCategoryIds = [...categoryNeg.entries()]
      .filter(
        ([id, neg]) =>
          (categoryNegEvents.get(id) ?? 0) >= NEGATIVE_CATEGORY_MIN_EVENTS &&
          neg > (categoryPos.get(id) ?? 0),
      )
      .map(([id]) => id);

    return {
      positiveCount,
      eventCount: events.length,
      categoryAffinity: normalizeAffinity(categoryPos),
      counterpartyAffinity: normalizeAffinity(counterparty),
      amountBandAffinity: {},
      paymentFlowAffinity: {},
      negativeCategoryIds,
    };
  }

  /**
   * Learns how far this worker actually travels, from jobs they saw through.
   *
   * Replaces a single global 5 km half-life applied to everyone — which is simply
   * wrong for anyone who commutes. Uses the 75th percentile of realised
   * distances so one unusually distant job doesn't stretch the whole profile.
   */
  private async learnDistanceTolerance(
    profileId: string,
    asOf?: Date,
  ): Promise<number | null> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { latitude: true, longitude: true },
    });
    if (profile?.latitude == null || profile.longitude == null) return null;

    const applications = await this.prisma.application.findMany({
      where: {
        worker_id: profileId,
        status: { in: ['ACCEPTED', 'STARTED', 'END'] },
        ...(asOf ? { created_at: { lt: asOf } } : {}),
        job_offer: { latitude: { not: null }, longitude: { not: null } },
      },
      select: { job_offer: { select: { latitude: true, longitude: true } } },
      take: 200,
    });
    if (applications.length < 3) return null; // too little evidence to learn from

    const distances = applications
      .map((a) =>
        a.job_offer?.latitude != null && a.job_offer.longitude != null
          ? haversineKm(
              { lat: profile.latitude!, lng: profile.longitude! },
              { lat: a.job_offer.latitude, lng: a.job_offer.longitude },
            )
          : null,
      )
      .filter((d): d is number => d !== null && Number.isFinite(d))
      .sort((a, b) => a - b);
    if (distances.length < 3) return null;

    const p75 = distances[Math.floor(distances.length * 0.75)] ?? distances.at(-1)!;
    return Math.min(
      MAX_DISTANCE_HALF_LIFE_KM,
      Math.max(MIN_DISTANCE_HALF_LIFE_KM, p75),
    );
  }

  private async persist(
    profileId: string,
    features: UserFeatures,
    lastEventAt: Date | null,
  ): Promise<void> {
    const data = {
      event_count: features.eventCount,
      positive_count: features.positiveCount,
      last_event_at: lastEventAt,
      category_affinity: features.categoryAffinity as Prisma.InputJsonValue,
      counterparty_affinity:
        features.counterpartyAffinity as Prisma.InputJsonValue,
      amount_band_affinity:
        features.amountBandAffinity as Prisma.InputJsonValue,
      payment_flow_affinity:
        features.paymentFlowAffinity as Prisma.InputJsonValue,
      negative_category_ids: features.negativeCategoryIds,
      distance_half_life_km: features.distanceHalfLifeKm,
    };
    try {
      await this.prisma.interactionProfile.upsert({
        where: { profile_id: profileId },
        create: { profile_id: profileId, ...data },
        update: data,
      });
    } catch (err) {
      this.logger.warn(`Failed to persist features for ${profileId}`, err);
    }
  }
}

function asRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp01(v);
  }
  return out;
}
