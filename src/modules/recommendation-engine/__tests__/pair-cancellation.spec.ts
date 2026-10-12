import { ApplicationCancelledBy } from '@prisma/client';
import {
  applyPenalties,
  pairCancellationFactor,
  withPairCancellation,
} from '../scoring';
import { loadPairCancellationFactors, pairKey } from '../pair-cancellation';

const DAY = 24 * 60 * 60 * 1000;

describe('pairCancellationFactor', () => {
  it('is neutral with no cancellation', () => {
    expect(pairCancellationFactor([], 0.25, 180)).toBe(1);
  });

  it('takes the full strength off a fresh cancellation', () => {
    expect(pairCancellationFactor([0], 0.25, 180)).toBeCloseTo(0.75);
  });

  it('fades linearly with age', () => {
    expect(pairCancellationFactor([90], 0.25, 180)).toBeCloseTo(0.875);
  });

  it('is gone once the decay has run out', () => {
    expect(pairCancellationFactor([200], 0.25, 180)).toBe(1);
  });

  it('compounds several cancellations', () => {
    expect(pairCancellationFactor([0, 0], 0.25, 180)).toBeCloseTo(0.5625);
  });
});

describe('withPairCancellation', () => {
  it('lowers the displayed compatibility', () => {
    expect(withPairCancellation(0.8, 0.75)).toBeCloseTo(0.6);
  });

  it('keeps an unknown compatibility unknown', () => {
    expect(withPairCancellation(null, 0.5)).toBeNull();
  });
});

describe('applyPenalties pairCancellation', () => {
  it('multiplies the ranking score by the pair factor', () => {
    expect(applyPenalties(0.8, { pairCancellation: 0.5 })).toBeCloseTo(0.4);
  });

  it('leaves the score alone without one', () => {
    expect(applyPenalties(0.8, {})).toBeCloseTo(0.8);
  });
});

describe('loadPairCancellationFactors', () => {
  const now = Date.UTC(2026, 9, 11);
  const systemConfig = {
    getPairCancellationPenalty: jest
      .fn()
      .mockResolvedValue({ strength: 0.25, decayDays: 180 }),
  };

  it('groups the worker cancellations by (worker, employer)', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        worker_id: 'w1',
        cancelled_at: new Date(now),
        job_offer: { employer_id: 'e1' },
      },
      {
        worker_id: 'w1',
        cancelled_at: new Date(now - 90 * DAY),
        job_offer: { employer_id: 'e1' },
      },
      {
        worker_id: 'w2',
        cancelled_at: new Date(now),
        job_offer: { employer_id: 'e1' },
      },
    ]);
    const factors = await loadPairCancellationFactors(
      { application: { findMany } } as never,
      systemConfig as never,
      { workerIds: ['w1', 'w2'], employerIds: ['e1'] },
      now,
    );

    expect(factors.get(pairKey('w1', 'e1'))).toBeCloseTo(0.75 * 0.875);
    expect(factors.get(pairKey('w2', 'e1'))).toBeCloseTo(0.75);
    const where = findMany.mock.calls[0][0].where;
    expect(where.cancelled_by).toBe(ApplicationCancelledBy.WORKER);
    expect(where.cancelled_at.gte).toEqual(new Date(now - 180 * DAY));
    expect(where.worker_id).toEqual({ in: ['w1', 'w2'] });
    expect(where.job_offer).toEqual({ employer_id: { in: ['e1'] } });
  });

  it('reads nothing for an empty scope', async () => {
    const findMany = jest.fn();
    const factors = await loadPairCancellationFactors(
      { application: { findMany } } as never,
      systemConfig as never,
      { workerIds: [] },
      now,
    );
    expect(factors.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('degrades to no penalty when the read fails', async () => {
    const findMany = jest.fn().mockRejectedValue(new Error('db down'));
    const factors = await loadPairCancellationFactors(
      { application: { findMany } } as never,
      systemConfig as never,
      { workerIds: ['w1'] },
      now,
    );
    expect(factors.size).toBe(0);
  });
});
