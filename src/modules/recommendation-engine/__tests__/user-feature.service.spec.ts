import { Logger } from '@nestjs/common';
import { UserFeatureService, EMPTY_FEATURES } from '../user-feature.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

const ev = (over: Partial<Parameters<UserFeatureService['deriveFeatures']>[0][number]> = {}) => ({
  kind: 'APPLY',
  weight: 1,
  occurred_at: daysAgo(1),
  category_id: 'cat-a',
  counterparty_id: 'emp-1',
  ...over,
});

function makePrisma() {
  return {
    interactionProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    interactionEvent: { findMany: jest.fn().mockResolvedValue([]) },
    profile: { findUnique: jest.fn().mockResolvedValue(null) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('UserFeatureService', () => {
  let service: UserFeatureService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    service = new UserFeatureService(prisma as never);
  });

  describe('deriveFeatures', () => {
    it('measures age from asOf, not wall-clock', () => {
      // Regression: the decay call reduced algebraically to wall-clock time, so
      // a replay 100 days back dropped anything now past the 180-day cliff —
      // even history that was only 90 days old at the moment being replayed.
      const events = [
        ev({ category_id: 'old', occurred_at: daysAgo(190) }),
        ev({ category_id: 'recent', occurred_at: daysAgo(101) }),
      ];
      const asOf = daysAgo(100);

      const replay = service.deriveFeatures(events, asOf);
      expect(Object.keys(replay.categoryAffinity).sort()).toEqual([
        'old',
        'recent',
      ]);
      expect(replay.positiveCount).toBe(2);

      // Evaluated today, the 190-day-old event really is past the cliff.
      const live = service.deriveFeatures(events);
      expect(live.categoryAffinity.old).toBeUndefined();
      expect(live.positiveCount).toBe(1);
    });

    it('lets repeated negatives cancel out a counterparty', () => {
      // Previously only positives accumulated here, so a worker rejected over
      // and over by one employer built no negative signal and that employer's
      // offers kept resurfacing at neutral weight.
      const f = service.deriveFeatures([
        ev({ counterparty_id: 'good', weight: 1 }),
        ev({ counterparty_id: 'bad', weight: 1 }),
        ev({ counterparty_id: 'bad', weight: -0.5, kind: 'REJECT' }),
        ev({ counterparty_id: 'bad', weight: -0.9, kind: 'REJECT' }),
      ]);

      expect(f.counterpartyAffinity.good).toBeGreaterThan(0);
      // Net negative → drops out entirely rather than ranking neutral.
      expect(f.counterpartyAffinity.bad).toBeUndefined();
    });

    it('returns neutral features for a user with no history', () => {
      const f = service.deriveFeatures([]);
      expect(f.positiveCount).toBe(0);
      expect(f.categoryAffinity).toEqual({});
      expect(f.negativeCategoryIds).toEqual([]);
    });

    it('scores the most-engaged category at 1 and others proportionally', () => {
      const f = service.deriveFeatures([
        ev({ category_id: 'cat-a' }),
        ev({ category_id: 'cat-a' }),
        ev({ category_id: 'cat-b' }),
      ]);
      expect(f.categoryAffinity['cat-a']).toBe(1);
      expect(f.categoryAffinity['cat-b']).toBeCloseTo(0.5, 1);
    });

    it('weights recent interactions above old ones', () => {
      const recent = service.deriveFeatures([
        ev({ category_id: 'cat-a', occurred_at: daysAgo(1) }),
        ev({ category_id: 'cat-b', occurred_at: daysAgo(60) }),
      ]);
      expect(recent.categoryAffinity['cat-a']).toBe(1);
      expect(recent.categoryAffinity['cat-b']).toBeLessThan(0.5);
    });

    it('ignores events past the decay horizon entirely', () => {
      const f = service.deriveFeatures([
        ev({ category_id: 'cat-old', occurred_at: daysAgo(400) }),
      ]);
      expect(f.categoryAffinity['cat-old']).toBeUndefined();
      expect(f.positiveCount).toBe(0);
    });

    it('builds counterparty affinity so a trusted employer surfaces again', () => {
      const f = service.deriveFeatures([
        ev({ counterparty_id: 'emp-1' }),
        ev({ counterparty_id: 'emp-1' }),
        ev({ counterparty_id: 'emp-2' }),
      ]);
      expect(f.counterpartyAffinity['emp-1']).toBe(1);
      expect(f.counterpartyAffinity['emp-2']).toBeLessThan(1);
    });

    it('counts only positive events toward maturity', () => {
      const f = service.deriveFeatures([
        ev({ weight: 1 }),
        ev({ weight: 1 }),
        ev({ weight: -0.5, kind: 'REJECT' }),
      ]);
      expect(f.positiveCount).toBe(2);
      expect(f.eventCount).toBe(3);
    });

    describe('negative categories', () => {
      it('needs repeated negatives — a single bad experience is not enough', () => {
        // One rejection must never lock a worker out of their own trade.
        const f = service.deriveFeatures([
          ev({ weight: -0.5, kind: 'REJECT', category_id: 'cat-a' }),
        ]);
        expect(f.negativeCategoryIds).toEqual([]);
      });

      it('marks a category negative after repeated negatives with no positives', () => {
        const f = service.deriveFeatures([
          ev({ weight: -0.5, kind: 'REJECT', category_id: 'cat-a' }),
          ev({ weight: -0.5, kind: 'REJECT', category_id: 'cat-a' }),
        ]);
        expect(f.negativeCategoryIds).toEqual(['cat-a']);
      });

      it('does NOT mark a category negative when positives outweigh them', () => {
        // Someone who mostly succeeds in a trade but lost two races still likes
        // that trade.
        const f = service.deriveFeatures([
          ev({ weight: -0.5, kind: 'REJECT', category_id: 'cat-a' }),
          ev({ weight: -0.5, kind: 'REJECT', category_id: 'cat-a' }),
          ev({ weight: 1.2, kind: 'COMPLETE', category_id: 'cat-a' }),
          ev({ weight: 1.0, kind: 'APPLY', category_id: 'cat-a' }),
        ]);
        expect(f.negativeCategoryIds).toEqual([]);
      });
    });

    it('gives two users with identical profiles DIFFERENT features', () => {
      // The whole point of the rewrite: divergence comes from behaviour, not
      // from profile attributes.
      const a = service.deriveFeatures([
        ev({ category_id: 'menage', counterparty_id: 'emp-1' }),
        ev({ category_id: 'menage', counterparty_id: 'emp-1' }),
      ]);
      const b = service.deriveFeatures([
        ev({ category_id: 'plomberie', counterparty_id: 'emp-2' }),
        ev({ category_id: 'plomberie', counterparty_id: 'emp-2' }),
      ]);
      expect(a.categoryAffinity).not.toEqual(b.categoryAffinity);
      expect(a.counterpartyAffinity).not.toEqual(b.counterpartyAffinity);
      expect(a.categoryAffinity['menage']).toBe(1);
      expect(b.categoryAffinity['menage']).toBeUndefined();
    });

    it('keeps every affinity within [0,1]', () => {
      const f = service.deriveFeatures(
        Array.from({ length: 50 }, (_, i) =>
          ev({ category_id: `cat-${i % 5}`, weight: 1.2 }),
        ),
      );
      for (const v of Object.values(f.categoryAffinity)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('asOf — offline replay safety', () => {
    it('excludes events at or after the cutoff from the query', async () => {
      const asOf = daysAgo(7);
      await service.rebuild('w-1', asOf);

      const where = prisma.interactionEvent.findMany.mock.calls[0][0].where;
      // Future leakage is what makes an offline eval look great and the online
      // test disappoint — the cutoff must be enforced in the query itself.
      expect(where.occurred_at).toEqual({ lt: asOf });
    });

    it('does not constrain time when no cutoff is given', async () => {
      await service.rebuild('w-1');
      const where = prisma.interactionEvent.findMany.mock.calls[0][0].where;
      expect(where.occurred_at).toBeUndefined();
    });
  });

  describe('get', () => {
    it('falls back to neutral features when no projection exists', async () => {
      expect(await service.get('w-1')).toEqual(EMPTY_FEATURES);
    });

    it('reads the stored projection', async () => {
      prisma.interactionProfile.findUnique.mockResolvedValue({
        positive_count: 12,
        event_count: 30,
        category_affinity: { 'cat-a': 1, 'cat-b': 0.4 },
        counterparty_affinity: {},
        amount_band_affinity: {},
        payment_flow_affinity: {},
        negative_category_ids: ['cat-z'],
        distance_half_life_km: 12,
      });
      const f = await service.get('w-1');
      expect(f.positiveCount).toBe(12);
      expect(f.categoryAffinity['cat-a']).toBe(1);
      expect(f.negativeCategoryIds).toEqual(['cat-z']);
      expect(f.distanceHalfLifeKm).toBe(12);
    });

    it('sanitises a malformed affinity blob rather than trusting it', async () => {
      prisma.interactionProfile.findUnique.mockResolvedValue({
        positive_count: 1,
        event_count: 1,
        category_affinity: { good: 0.5, bad: 'oops', huge: 99 },
        counterparty_affinity: null,
        amount_band_affinity: [],
        payment_flow_affinity: {},
        negative_category_ids: [],
        distance_half_life_km: null,
      });
      const f = await service.get('w-1');
      expect(f.categoryAffinity).toEqual({ good: 0.5, huge: 1 });
      expect(f.counterpartyAffinity).toEqual({});
      expect(f.amountBandAffinity).toEqual({});
      // Falls back to the global default rather than NaN.
      expect(f.distanceHalfLifeKm).toBe(5);
    });
  });

  describe('getMany', () => {
    const storedRow = (profileId: string, halfLife: number) => ({
      profile_id: profileId,
      positive_count: 5,
      event_count: 9,
      category_affinity: { 'cat-a': 1 },
      counterparty_affinity: {},
      amount_band_affinity: {},
      payment_flow_affinity: {},
      negative_category_ids: ['cat-z'],
      distance_half_life_km: halfLife,
    });

    it('does not query for an empty batch', async () => {
      expect((await service.getMany([])).size).toBe(0);
      expect(prisma.interactionProfile.findMany).not.toHaveBeenCalled();
    });

    it('reads a whole batch in one query', async () => {
      // The reason this exists: ranking eighty candidates on their own learned
      // tolerance would otherwise be eighty sequential findUniques.
      prisma.interactionProfile.findMany.mockResolvedValue([
        storedRow('w-1', 12),
        storedRow('w-2', 30),
      ]);

      const out = await service.getMany(['w-1', 'w-2']);

      expect(prisma.interactionProfile.findMany).toHaveBeenCalledTimes(1);
      expect(out.get('w-1')!.distanceHalfLifeKm).toBe(12);
      expect(out.get('w-2')!.distanceHalfLifeKm).toBe(30);
      expect(out.get('w-1')!.negativeCategoryIds).toEqual(['cat-z']);
    });

    it('returns neutral features for ids with no projection', async () => {
      // So a caller never has to tell "no row" from "no history".
      prisma.interactionProfile.findMany.mockResolvedValue([
        storedRow('w-1', 12),
      ]);

      const out = await service.getMany(['w-1', 'unseen']);

      expect(out.get('unseen')).toEqual(EMPTY_FEATURES);
    });

    it('maps a row exactly as `get` does', async () => {
      // One mapping, so a batch read can never drift from a single read.
      prisma.interactionProfile.findUnique.mockResolvedValue(
        storedRow('w-1', 12),
      );
      prisma.interactionProfile.findMany.mockResolvedValue([
        storedRow('w-1', 12),
      ]);

      expect((await service.getMany(['w-1'])).get('w-1')).toEqual(
        await service.get('w-1'),
      );
    });
  });

  describe('learned distance tolerance', () => {
    const atOrigin = { latitude: 0, longitude: 0 };
    const offerAt = (lng: number) => ({
      job_offer: { latitude: 0, longitude: lng },
    });

    it('defaults when the worker has no coordinates', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        latitude: null,
        longitude: null,
      });
      const f = await service.rebuild('w-1');
      expect(f.distanceHalfLifeKm).toBe(5);
    });

    it('defaults when there is too little evidence to learn from', async () => {
      prisma.profile.findUnique.mockResolvedValue(atOrigin);
      prisma.application.findMany.mockResolvedValue([offerAt(0.5)]);
      const f = await service.rebuild('w-1');
      expect(f.distanceHalfLifeKm).toBe(5);
    });

    it('learns a longer tolerance for someone who commutes', async () => {
      prisma.profile.findUnique.mockResolvedValue(atOrigin);
      // ~0.09° lng ≈ 10km at the equator.
      prisma.application.findMany.mockResolvedValue([
        offerAt(0.09),
        offerAt(0.135),
        offerAt(0.18),
        offerAt(0.18),
      ]);
      const f = await service.rebuild('w-1');
      expect(f.distanceHalfLifeKm).toBeGreaterThan(5);
    });

    it('clamps the learned value into a sane range', async () => {
      prisma.profile.findUnique.mockResolvedValue(atOrigin);
      prisma.application.findMany.mockResolvedValue([
        offerAt(5),
        offerAt(6),
        offerAt(7),
        offerAt(8),
      ]);
      const f = await service.rebuild('w-1');
      expect(f.distanceHalfLifeKm).toBeLessThanOrEqual(25);
      expect(f.distanceHalfLifeKm).toBeGreaterThanOrEqual(2);
    });
  });

  describe('rebuild', () => {
    it('persists the derived projection', async () => {
      prisma.interactionEvent.findMany.mockResolvedValue([
        ev({ category_id: 'cat-a' }),
      ]);
      await service.rebuild('w-1');
      expect(prisma.interactionProfile.upsert).toHaveBeenCalled();
      const call = prisma.interactionProfile.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ profile_id: 'w-1' });
      expect(call.update.category_affinity).toEqual({ 'cat-a': 1 });
    });

    it('still returns features when persistence fails', async () => {
      prisma.interactionProfile.upsert.mockRejectedValue(new Error('db down'));
      prisma.interactionEvent.findMany.mockResolvedValue([ev()]);
      const f = await service.rebuild('w-1');
      expect(f.positiveCount).toBe(1);
    });
  });
});
