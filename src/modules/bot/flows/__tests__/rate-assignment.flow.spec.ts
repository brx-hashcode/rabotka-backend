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
    payload: { assignmentId: 'assign-1', rateeId: 'ratee-1' },
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
  return {
    prisma: {
      assignment: {
        findUnique: jest.fn().mockResolvedValue(assignment),
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(tx)),
      _tx: tx,
    } as any,
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

  it('returns error for score out of range (0)', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      '0',
      workerProfile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
  });

  it('returns error for score out of range (6)', async () => {
    const ctx = makeCtx();
    const result = await runRateAssignmentFlow(
      makeState(),
      '6',
      workerProfile,
      ctx,
    );
    expect(result.nextState).toBeDefined();
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
});

describe('getRateAssignmentInitialState', () => {
  it('returns correct initial state', () => {
    const state = getRateAssignmentInitialState('assign-1', 'ratee-1');
    expect(state.flowId).toBe(FLOW_IDS.RATE_ASSIGNMENT);
    expect(state.payload?.assignmentId).toBe('assign-1');
    expect(state.payload?.rateeId).toBe('ratee-1');
  });
});
