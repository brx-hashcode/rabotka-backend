import { Logger } from '@nestjs/common';
import {
  InteractionEventService,
  INTERACTION_WEIGHTS,
} from '../interaction-event.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makePrisma() {
  return {
    interactionEvent: {
      create: jest.fn().mockResolvedValue({ id: 'e-1' }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeRedis() {
  return {
    // `set NX` returns 'OK' when the key was free, null when it already existed.
    set: jest.fn().mockResolvedValue('OK'),
  };
}

const baseEvent = {
  actorId: 'w-1',
  actorType: 'WORKER' as const,
  kind: 'APPLY' as const,
  objectType: 'JOB_OFFER' as const,
  objectId: 'jo-1',
  source: 'SERVER' as const,
};

describe('InteractionEventService', () => {
  let service: InteractionEventService;
  let prisma: ReturnType<typeof makePrisma>;
  let redis: ReturnType<typeof makeRedis>;

  const lastCreateData = () =>
    prisma.interactionEvent.create.mock.calls.at(-1)?.[0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    redis = makeRedis();
    service = new InteractionEventService(prisma as never, redis as never);
  });

  describe('weights', () => {
    it('scales positives by commitment', () => {
      // A glance must never outweigh a paid contact or a completed job.
      expect(INTERACTION_WEIGHTS.VIEW).toBeLessThan(INTERACTION_WEIGHTS.SAVE);
      expect(INTERACTION_WEIGHTS.SAVE).toBeLessThan(INTERACTION_WEIGHTS.APPLY);
      expect(INTERACTION_WEIGHTS.APPLY).toBeLessThan(
        INTERACTION_WEIGHTS.COMPLETE,
      );
      expect(INTERACTION_WEIGHTS.CONTACT_PAID).toBeGreaterThan(
        INTERACTION_WEIGHTS.PROFILE_VIEW,
      );
    });

    it('keeps negatives negative and bounded', () => {
      for (const kind of [
        'REJECT',
        'APPLY_CANCEL',
        'UNSAVE',
        'SKIP',
        'DISLIKE',
        'RATE_NEGATIVE',
        'NO_SHOW',
      ] as const) {
        expect(INTERACTION_WEIGHTS[kind]).toBeLessThan(0);
        expect(INTERACTION_WEIGHTS[kind]).toBeGreaterThanOrEqual(-1);
      }
    });

    it('gives bookkeeping kinds zero weight', () => {
      // These describe what we showed, not what the user preferred.
      expect(INTERACTION_WEIGHTS.IMPRESSION_BATCH).toBe(0);
      expect(INTERACTION_WEIGHTS.RECOMMENDATION_SERVED).toBe(0);
      expect(INTERACTION_WEIGHTS.SEARCH).toBe(0);
    });

    it('never lets a single rejection outweigh a completed job', () => {
      expect(Math.abs(INTERACTION_WEIGHTS.REJECT)).toBeLessThan(
        INTERACTION_WEIGHTS.COMPLETE,
      );
    });
  });

  describe('record', () => {
    it('persists the resolved weight for the kind', async () => {
      await service.record(baseEvent);
      expect(lastCreateData()).toMatchObject({
        actor_id: 'w-1',
        kind: 'APPLY',
        object_id: 'jo-1',
        weight: INTERACTION_WEIGHTS.APPLY,
      });
    });

    it('denormalises category and counterparty at write time', async () => {
      await service.record({
        ...baseEvent,
        categoryId: 'cat-1',
        counterpartyId: 'emp-1',
      });
      expect(lastCreateData()).toMatchObject({
        category_id: 'cat-1',
        counterparty_id: 'emp-1',
      });
    });

    it('accepts an explicit occurredAt so backfilled decay stays honest', async () => {
      const occurredAt = new Date('2026-01-15T10:00:00Z');
      await service.record({ ...baseEvent, source: 'BACKFILL', occurredAt });
      expect(lastCreateData()).toMatchObject({ occurred_at: occurredAt });
    });

    it('omits occurred_at when not supplied, letting the DB default apply', async () => {
      await service.record(baseEvent);
      expect(lastCreateData()).not.toHaveProperty('occurred_at');
    });

    it('honours an explicit weight override', async () => {
      await service.record({ ...baseEvent, weight: 0.42 });
      expect(lastCreateData()).toMatchObject({ weight: 0.42 });
    });

    it('never throws when the write fails', async () => {
      prisma.interactionEvent.create.mockRejectedValue(new Error('db down'));
      // Recording a signal must not be able to fail a user's request.
      await expect(service.record(baseEvent)).resolves.toBeUndefined();
    });
  });

  describe('dedupe window', () => {
    it('suppresses a repeated VIEW inside the window', async () => {
      redis.set.mockResolvedValue(null); // key already present
      await service.record({ ...baseEvent, kind: 'VIEW' });
      expect(prisma.interactionEvent.create).not.toHaveBeenCalled();
    });

    it('records a VIEW when the window has expired', async () => {
      redis.set.mockResolvedValue('OK');
      await service.record({ ...baseEvent, kind: 'VIEW' });
      expect(prisma.interactionEvent.create).toHaveBeenCalled();
    });

    it('NEVER suppresses commitment kinds, even back-to-back', async () => {
      redis.set.mockResolvedValue(null);
      for (const kind of [
        'APPLY',
        'ACCEPT',
        'REJECT',
        'COMPLETE',
        'CONTACT_PAID',
        'SAVE',
      ] as const) {
        await service.record({ ...baseEvent, kind });
      }
      expect(prisma.interactionEvent.create).toHaveBeenCalledTimes(6);
      // Not even consulted for these kinds.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('records the signal when Redis is unavailable', async () => {
      // Losing dedup is far cheaper than losing the signal.
      redis.set.mockRejectedValue(new Error('redis down'));
      await service.record({ ...baseEvent, kind: 'VIEW' });
      expect(prisma.interactionEvent.create).toHaveBeenCalled();
    });

    it('scopes the dedupe key by actor, kind and object', async () => {
      await service.record({ ...baseEvent, kind: 'VIEW' });
      const key = redis.set.mock.calls[0][0] as string;
      expect(key).toContain('w-1');
      expect(key).toContain('VIEW');
      expect(key).toContain('jo-1');
    });

    it('cannot dedupe an event with no object id', async () => {
      redis.set.mockResolvedValue(null);
      await service.record({
        actorId: 'w-1',
        actorType: 'WORKER',
        kind: 'SEARCH',
        objectType: 'SEARCH',
        source: 'WEB',
        metadata: { q: 'menage' },
      });
      expect(prisma.interactionEvent.create).toHaveBeenCalled();
    });
  });

  describe('recordMany', () => {
    it('bulk-inserts and returns the count', async () => {
      prisma.interactionEvent.createMany.mockResolvedValue({ count: 2 });
      const n = await service.recordMany([
        baseEvent,
        { ...baseEvent, objectId: 'jo-2' },
      ]);
      expect(n).toBe(2);
      expect(prisma.interactionEvent.createMany).toHaveBeenCalled();
    });

    it('is a no-op for an empty batch', async () => {
      expect(await service.recordMany([])).toBe(0);
      expect(prisma.interactionEvent.createMany).not.toHaveBeenCalled();
    });

    it('returns 0 rather than throwing when the batch fails', async () => {
      prisma.interactionEvent.createMany.mockRejectedValue(new Error('nope'));
      expect(await service.recordMany([baseEvent])).toBe(0);
    });
  });
});
