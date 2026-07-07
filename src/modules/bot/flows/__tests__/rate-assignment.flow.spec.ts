import {
  runRateAssignmentFlow,
  getRateAssignmentInitialState,
} from '../rate-assignment.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

function makeState(overrides: Partial<BotState> = {}): BotState {
  return {
    flowId: FLOW_IDS.RATE_ASSIGNMENT,
    step: 1,
    payload: { assignmentId: 'assign-1', rateeId: 'employer-1' },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(
  txOverrides: any = {},
  assignment: any = {
    status: 'COMPLETED',
    worker_id: 'worker-1',
    job_offer: { employer_id: 'employer-1' },
  },
) {
  const tx = {
    rating: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _avg: { score: 4.5 }, _count: { score: 10 } }),
    },
    profile: {
      update: jest.fn().mockResolvedValue({}),
    },
    ...txOverrides,
  };
  const applicationService = {
    applyRatingToReliability: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma: {
      assignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
      _tx: tx,
    } as any,
    applicationService: applicationService as any,
    _applicationService: applicationService,
  };
}

describe('runRateAssignmentFlow', () => {
  it('cancels when menu command received', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      'menu',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Menu');
  });

  it('returns error when no assignmentId in state', async () => {
    const ctx = makeCtx();
    const state = makeState({ payload: {} });
    const result = await runRateAssignmentFlow(state, '4', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('returns error when no rateeId in state', async () => {
    const ctx = makeCtx();
    const state = makeState({ payload: { assignmentId: 'a1' } });
    const result = await runRateAssignmentFlow(state, '4', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('returns error for invalid score (NaN)', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      'abc',
      workerProfile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('1');
  });

  it('saves rating successfully with score 4', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      '4',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('4/5');
  });

  it('saves rating successfully with score 1', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      '1',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('1/5');
  });

  it('saves rating successfully with score 5', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      '5',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('5/5');
  });

  it('rejects tampered rateeId that does not match the DB counter-party', async () => {
    // Worker rates, so expected rateeId = employer_id = 'employer-1'
    // State has been tampered to point at a third party
    const state = makeState({ payload: { assignmentId: 'assign-1', rateeId: 'third-party-99' } });
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(state, '4', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Erreur');
  });

  it('rejects when assignment is not found', async () => {
    const ctx = makeCtx({}, null);
    const result = await runRateAssignmentFlow(makeState(), '4', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('introuvable');
  });

  it('rejects when profile is not a participant of the assignment', async () => {
    const outsiderProfile: BotProfile = { ...workerProfile, id: 'outsider-99' };
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(makeState(), '4', outsiderProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('autorisé');
  });

  it('rejects when assignment is not yet completed', async () => {
    const ctx = makeCtx({}, {
      status: 'CONFIRMED',
      worker_id: 'worker-1',
      job_offer: { employer_id: 'employer-1' },
    });
    const result = await runRateAssignmentFlow(makeState(), '4', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('terminée');
  });

  it('returns error for score out of range (0) with retry prompt', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(makeState(), '0', workerProfile, ctx);
    expect(result.nextState).toBeDefined();
    expect(result.clearState).toBeFalsy();
    expect(result.reply[0]).toContain('1');
  });

  it('returns error for score out of range (6) with retry prompt', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(makeState(), '6', workerProfile, ctx);
    expect(result.nextState).toBeDefined();
    expect(result.clearState).toBeFalsy();
    expect(result.reply[0]).toContain('5');
  });

  it('returns error when transaction fails', async () => {
    const ctx = {
      prisma: {
        assignment: {
          findUnique: jest.fn().mockResolvedValue({
            status: 'COMPLETED',
            worker_id: 'worker-1',
            job_offer: { employer_id: 'employer-1' },
          }),
        },
        $transaction: jest.fn().mockRejectedValue(new Error('DB error')),
      } as any,
    };
    const result = await runRateAssignmentFlow(
      makeState(),
      '3',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Menu');
  });

  describe('reliability score feed (employer rates worker)', () => {
    const employerProfile: BotProfile = {
      id: 'employer-1',
      first_name: 'Marc',
      last_name: 'Patron',
      phone: '+242000009',
      email: 'marc@example.com',
      profile_type: 'EMPLOYER',
      reliability_score: 100,
      status: 'ACTIVE',
    };
    // Employer rates → ratee is the worker
    const employerRatesState = makeState({
      payload: { assignmentId: 'assign-1', rateeId: 'worker-1' },
    });

    it('applies the rating delta to the worker on first rating', async () => {
      const ctx = makeCtx();
      await runRateAssignmentFlow(employerRatesState, '5', employerProfile, ctx);
      expect(
        (ctx as any)._applicationService.applyRatingToReliability,
      ).toHaveBeenCalledWith(expect.anything(), 'worker-1', 5);
    });

    it('does NOT apply the delta on a re-rating (already rated)', async () => {
      const ctx = makeCtx({
        rating: {
          findUnique: jest.fn().mockResolvedValue({ id: 'existing-rating' }),
          upsert: jest.fn().mockResolvedValue({}),
          aggregate: jest
            .fn()
            .mockResolvedValue({ _avg: { score: 4 }, _count: { score: 2 } }),
        },
      });
      await runRateAssignmentFlow(employerRatesState, '2', employerProfile, ctx);
      expect(
        (ctx as any)._applicationService.applyRatingToReliability,
      ).not.toHaveBeenCalled();
    });

    it('does NOT feed reliability when the worker rates the employer', async () => {
      const ctx = makeCtx();
      // worker rates → ratee is employer-1; reliability feed should be skipped
      await runRateAssignmentFlow(makeState(), '5', workerProfile, ctx);
      expect(
        (ctx as any)._applicationService.applyRatingToReliability,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('getRateAssignmentInitialState', () => {
  it('returns correct initial state', () => {
    const state = getRateAssignmentInitialState('assign-1', 'employer-1');
    expect(state.flowId).toBe(FLOW_IDS.RATE_ASSIGNMENT);
    expect(state.payload?.assignmentId).toBe('assign-1');
    expect(state.payload?.rateeId).toBe('employer-1');
  });
});
