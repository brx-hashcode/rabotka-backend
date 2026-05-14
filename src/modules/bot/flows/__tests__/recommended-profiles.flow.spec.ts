import { runRecommendedProfilesFlow } from '../recommended-profiles.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const profile: BotProfile = {
  id: 'emp-1',
  first_name: 'Jean',
  last_name: 'Patron',
  phone: '+242000002',
  email: 'jean@test.com',
  profile_type: 'EMPLOYER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const workerIds = ['worker-1', 'worker-2', 'worker-3'];
const workerScores: Record<string, number> = { 'worker-1': 85, 'worker-2': 70, 'worker-3': 60 };

function makeState(step = 0, payload: Record<string, unknown> = {}): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_PROFILES,
    step,
    payload: {
      workerIds,
      workerScores,
      ...payload,
    },
    updatedAt: new Date().toISOString(),
  };
}

const mockWorker = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  reliability_score: 90,
  description: 'Expert plombier avec 5 ans d\'expérience',
  categories: [{ category: { name: 'Plomberie' } }],
};

function makeCtx(overrides: Record<string, unknown> = {}) {
  const txMock = {
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    wallet: { update: jest.fn().mockResolvedValue({}) },
    payment: { create: jest.fn().mockResolvedValue({}) },
    paymentRequest: { create: jest.fn().mockResolvedValue({ id: 'pr-1', token: 'tok' }) },
  };
  return {
    prisma: {
      profile: {
        findFirst: jest.fn().mockResolvedValue(mockWorker),
        findUnique: jest.fn().mockResolvedValue(mockWorker),
        findMany: jest.fn().mockResolvedValue([mockWorker, { id: 'worker-2', first_name: 'Bob', last_name: 'Smith', reliability_score: 70, description: null, categories: [] }, { id: 'worker-3', first_name: 'Charlie', last_name: 'Brown', reliability_score: 60, description: null, categories: [] }]),
      },
      application: {
        count: jest.fn().mockResolvedValue(2),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return [];
      }),
    } as any,
    systemConfig: {
      getRecommendationContactFee: jest.fn().mockResolvedValue(1000),
    } as any,
    contactUnlockService: {} as any,
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
      getOrCreateProfileWallet: jest.fn().mockResolvedValue({ id: 'pw-1', balance: 5000 }),
      getOrCreateSystemWallet: jest.fn().mockResolvedValue({ id: 'sw-1' }),
    } as any,
    paymentService: {
      createPaymentUrl: jest.fn().mockResolvedValue('http://pay.url'),
    } as any,
    botNotification: {
      sendMessage: jest.fn().mockResolvedValue(undefined),
    } as any,
    employerProfileId: 'emp-1',
    interestSignalService: {
      record: jest.fn().mockResolvedValue(undefined),
    } as any,
    invoiceService: {
      create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
    } as any,
    ...overrides,
  };
}

describe('runRecommendedProfilesFlow', () => {
  it('returns menu when menu command', async () => {
    const result = await runRecommendedProfilesFlow(makeState(), 'menu', profile, makeCtx());
    expect(result.clearState).toBe(true);
  });

  it('returns empty message when no workerIds', async () => {
    const state = makeState(0, { workerIds: [], workerScores: {} });
    const result = await runRecommendedProfilesFlow(state, '1', profile, makeCtx());
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucun profil');
  });

  it('shows list when input is not a choice', async () => {
    const result = await runRecommendedProfilesFlow(makeState(), 'hello', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles choice 1 - shows worker detail', async () => {
    const result = await runRecommendedProfilesFlow(makeState(), '1', profile, makeCtx());
    expect(result.nextState).toBeDefined();
  });

  it('handles choice 7 - returns to menu', async () => {
    const result = await runRecommendedProfilesFlow(makeState(), '7', profile, makeCtx());
    expect(result.clearState).toBe(true);
  });

  it('routes to mobile money subflow when _mm_step present', async () => {
    const state = makeState(0, { _mm_step: 'initial', _mm_amount: 1000, _mm_worker_id: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 1 with selectedWorkerId - returns to list on "2"', async () => {
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 1 with selectedWorkerId - returns to menu on "3"', async () => {
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '3', profile, makeCtx());
    expect(result.clearState).toBe(true);
  });

  it('handles step 1 - shows payment prompt on "1"', async () => {
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 1 - invalid input', async () => {
    const state = makeState(1, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, 'invalid', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 2 payment - wallet pay with sufficient balance on "1"', async () => {
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 2 payment - wallet pay fails when worker not found', async () => {
    const ctx = makeCtx();
    (ctx.prisma as any).profile.findFirst = jest.fn().mockResolvedValue(null);
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('handles step 2 payment - mobile money on "2"', async () => {
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '2', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 2 payment - go back to detail on "3"', async () => {
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '3', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles step 2 payment - insufficient balance on "1"', async () => {
    const ctx = makeCtx();
    (ctx.walletService as any).getProfileWalletBalance = jest.fn().mockResolvedValue(0);
    const state = makeState(2, { selectedWorkerId: 'worker-1' });
    const result = await runRecommendedProfilesFlow(state, '1', profile, ctx);
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it('handles renderedWorkerIds when set', async () => {
    const state = makeState(0, { renderedWorkerIds: ['worker-1', 'worker-2'] });
    const result = await runRecommendedProfilesFlow(state, '1', profile, makeCtx());
    expect(result.reply.length).toBeGreaterThan(0);
  });
});
