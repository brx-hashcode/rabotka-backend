import {
  runPayPenaltiesFlow,
  getPayPenaltiesInitialState,
} from '../pay-penalties.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { PayPenaltiesContext } from '../pay-penalties.flow';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 80,
  status: 'ACTIVE',
};

function makeCtx(
  markPenaltiesPaid: jest.Mock = jest.fn().mockResolvedValue({ paidCount: 2, totalAmount: 10000 }),
): PayPenaltiesContext {
  return {
    applicationService: {
      markPenaltiesPaid,
    } as unknown as PayPenaltiesContext['applicationService'],
  };
}

function makeState(penaltyCount = 2, totalAmount = 10000): BotState {
  return {
    flowId: FLOW_IDS.PAY_PENALTIES,
    step: 1,
    payload: { penaltyCount, totalAmount },
    updatedAt: new Date().toISOString(),
  };
}

describe('runPayPenaltiesFlow()', () => {
  it('shows penalty summary on default (no recognized input)', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '', workerProfile, ctx);
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('pénalité');
    expect(result.reply[0]).toContain('10');
  });

  it('goes to menu on "menu" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, 'menu', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('goes to menu on "retour" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, 'retour', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('goes to menu on "2" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '2', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('marks penalties paid on "1" input and returns success', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(ctx.applicationService.markPenaltiesPaid).toHaveBeenCalledWith('worker-1');
    expect(result.reply[0]).toContain('Paiement enregistré');
  });

  it('returns clear account message when no penalties found', async () => {
    const ctx = makeCtx(jest.fn().mockResolvedValue({ paidCount: 0, totalAmount: 0 }));
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucune pénalité');
  });
});

describe('getPayPenaltiesInitialState()', () => {
  it('returns correct initial state with penalty data', () => {
    const state = getPayPenaltiesInitialState(3, 15000);
    expect(state.flowId).toBe(FLOW_IDS.PAY_PENALTIES);
    expect(state.step).toBe(1);
    expect(state.payload?.penaltyCount).toBe(3);
    expect(state.payload?.totalAmount).toBe(15000);
  });
});
