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
  markPenaltiesPaid: jest.Mock = jest
    .fn()
    .mockResolvedValue({ paidCount: 2, totalAmount: 10000 }),
): PayPenaltiesContext {
  return {
    applicationService: {
      markPenaltiesPaid,
      getUnpaidPenalties: jest
        .fn()
        .mockResolvedValue({ count: 2, total: 10000, ids: ['p1', 'p2'] }),
    } as unknown as PayPenaltiesContext['applicationService'],
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(0),
      debitProfileWallet: jest.fn().mockResolvedValue(undefined),
      getOrCreateSystemWallet: jest.fn().mockResolvedValue({ id: 'sys-wallet' }),
      getOrCreateProfileWallet: jest.fn().mockResolvedValue({ id: 'profile-wallet' }),
    } as unknown as PayPenaltiesContext['walletService'],
    paymentService: {
      createPaymentUrl: jest
        .fn()
        .mockResolvedValue('https://pay.example.com/pay/token123'),
      initiateDirectPayment: jest
        .fn()
        .mockResolvedValue({ success: true, gatewayRef: 'gw-ref-123' }),
    } as unknown as PayPenaltiesContext['paymentService'],
    invoiceService: {
      create: jest.fn().mockResolvedValue({}),
    } as unknown as PayPenaltiesContext['invoiceService'],
    prisma: {
      $transaction: jest.fn().mockResolvedValue([]),
      walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      wallet: { update: jest.fn().mockResolvedValue({}) },
      paymentRequest: { create: jest.fn().mockResolvedValue({ id: 'pr-1' }) },
      payment: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PayPenaltiesContext['prisma'],
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

describe('runPayPenaltiesFlow() - step 1 main prompt', () => {
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

  it('goes to menu on "3" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '3', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('goes to menu on "annuler" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, 'annuler', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('enters mobile money sub-flow on "1" input', async () => {
    const ctx = makeCtx();
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
    expect(result.nextState).toBeDefined();
    expect(result.clearState).toBeUndefined();
  });

  it('shows wallet payment option with sufficient funds on "2"', async () => {
    const ctx = makeCtx();
    (ctx.walletService.getProfileWalletBalance as jest.Mock).mockResolvedValue(20000);
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '2', workerProfile, ctx);
    expect(result.reply[0]).toContain('portefeuille');
    expect(result.nextState?.step).toBe(2);
  });

  it('shows wallet option with insufficient funds on "2"', async () => {
    const ctx = makeCtx();
    (ctx.walletService.getProfileWalletBalance as jest.Mock).mockResolvedValue(100);
    const state = makeState();
    const result = await runPayPenaltiesFlow(state, '2', workerProfile, ctx);
    expect(result.reply[0]).toContain('insuffisant');
    // stays at step 1
    expect(result.nextState?.step).toBe(1);
  });
});

describe('runPayPenaltiesFlow() - step 2 wallet confirmation', () => {
  function makeStep2State() {
    return {
      flowId: FLOW_IDS.PAY_PENALTIES,
      step: 2,
      payload: { penaltyCount: 2, totalAmount: 10000 },
      updatedAt: new Date().toISOString(),
    };
  }

  it('cancels on "2"', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, '2', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('cancels on "annuler"', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, 'annuler', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('shows error for invalid input', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, 'blah', workerProfile, ctx);
    expect(result.reply[0]).toContain('1');
    expect(result.nextState).toBe(state);
  });

  it('confirms payment on "1" with sufficient balance', async () => {
    const ctx = makeCtx();
    (ctx.walletService.getProfileWalletBalance as jest.Mock).mockResolvedValue(20000);
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(ctx.walletService.debitProfileWallet).toHaveBeenCalled();
    expect(ctx.applicationService.markPenaltiesPaid).toHaveBeenCalled();
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Paiement par crédit');
  });

  it('confirms payment on "oui"', async () => {
    const ctx = makeCtx();
    (ctx.walletService.getProfileWalletBalance as jest.Mock).mockResolvedValue(20000);
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, 'oui', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('returns insufficient funds when balance < totalAmount', async () => {
    const ctx = makeCtx();
    (ctx.walletService.getProfileWalletBalance as jest.Mock).mockResolvedValue(100);
    const state = makeStep2State();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('insuffisant');
  });
});

describe('runPayPenaltiesFlow() - mobile money sub-flow continuation', () => {
  it('continues when _mm_step is present with "3" (fallback URL)', async () => {
    const state: BotState = {
      flowId: FLOW_IDS.PAY_PENALTIES,
      step: 1,
      payload: {
        penaltyCount: 2,
        totalAmount: 10000,
        _mm_step: 'use_registered_number',
        _mm_amount: 10000,
        _mm_description: 'Test penalties',
        _mm_requestType: 'PENALTY_BATCH',
        _mm_options: {},
      },
      updatedAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const result = await runPayPenaltiesFlow(state, '3', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('continues mobile money with "1" (use registered number)', async () => {
    const state: BotState = {
      flowId: FLOW_IDS.PAY_PENALTIES,
      step: 1,
      payload: {
        penaltyCount: 2,
        totalAmount: 10000,
        _mm_step: 'use_registered_number',
        _mm_amount: 10000,
        _mm_description: 'Test penalties',
        _mm_requestType: 'PENALTY_BATCH',
        _mm_options: {},
      },
      updatedAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const result = await runPayPenaltiesFlow(state, '1', workerProfile, ctx);
    expect(result.nextState?.payload?._mm_step).toBe('choose_operator');
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
