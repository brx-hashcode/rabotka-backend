import { runResolvePenaltiesFlow, getResolvePenaltiesInitialState } from '../resolve-penalties.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const profile: BotProfile = {
  id: 'profile-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

function makeState(step = 1, payload: any = {}): BotState {
  return {
    flowId: FLOW_IDS.RESOLVE_PENALTIES,
    step,
    payload,
    updatedAt: new Date().toISOString(),
  };
}

const mockPenalty = {
  id: 'pen-1',
  amount: 5000,
  reason: 'Annulation tardive',
  applied_at: new Date(),
};

function makeCtx(penalties: any[] = [mockPenalty]) {
  return {
    prisma: {
      penalty: {
        findMany: jest.fn().mockResolvedValue(penalties),
      },
    } as any,
    paymentService: {
      createPaymentUrl: jest.fn().mockResolvedValue('https://payment.example.com/pay123'),
    } as any,
  };
}

describe('runResolvePenaltiesFlow', () => {
  it('returns menu message when menu command sent at step 2', async () => {
    const ctx = makeCtx();
    const result = await runResolvePenaltiesFlow(makeState(2), 'menu', profile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('returns menu message when retour sent at step 2', async () => {
    const ctx = makeCtx();
    const result = await runResolvePenaltiesFlow(makeState(2), 'retour', profile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('shows no penalties message at step 1 with no penalties', async () => {
    const ctx = makeCtx([]);
    const result = await runResolvePenaltiesFlow(makeState(1), '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucune pénalité');
  });

  it('shows penalties list at step 1 with penalties', async () => {
    const ctx = makeCtx([mockPenalty]);
    const result = await runResolvePenaltiesFlow(makeState(1), '', profile, ctx);
    expect(result.nextState?.step).toBe(2);
    expect(result.reply[0]).toContain('pénalité');
  });

  it('returns payment link when user selects 1 at step 2', async () => {
    const ctx = makeCtx();
    const result = await runResolvePenaltiesFlow(makeState(2, { count: 1, total: 5000 }), '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('payment.example.com');
  });

  it('returns cancel message when user selects 2 at step 2', async () => {
    const ctx = makeCtx();
    const result = await runResolvePenaltiesFlow(makeState(2, { count: 1, total: 5000 }), '2', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('suspendu');
  });

  it('returns invalid option message at step 2 with unknown input', async () => {
    const ctx = makeCtx();
    const result = await runResolvePenaltiesFlow(makeState(2, { count: 1, total: 5000 }), 'invalid', profile, ctx);
    expect(result.nextState).toBeDefined();
  });

  it('shows penalties when more than 5 penalties', async () => {
    const manyPenalties = Array.from({ length: 7 }, (_, i) => ({
      id: `pen-${i}`,
      amount: 1000,
      reason: 'Test',
      applied_at: new Date(),
    }));
    const ctx = makeCtx(manyPenalties);
    const result = await runResolvePenaltiesFlow(makeState(1), '', profile, ctx);
    expect(result.nextState?.step).toBe(2);
  });
});

describe('getResolvePenaltiesInitialState', () => {
  it('returns initial state', () => {
    const state = getResolvePenaltiesInitialState();
    expect(state.flowId).toBe(FLOW_IDS.RESOLVE_PENALTIES);
    expect(state.step).toBe(1);
  });
});
