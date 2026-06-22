import {
  runCreditWalletFlow,
  getCreditWalletInitialState,
} from '../credit-wallet.flow';
import type { CreditWalletContext } from '../credit-wallet.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242061234567',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 80,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  id: 'employer-1',
  profile_type: 'EMPLOYER',
};

function makeCtx(balance = 5000): CreditWalletContext {
  return {
    paymentService: {
      createPaymentUrl: jest
        .fn()
        .mockResolvedValue('https://pay.example.com/pay/token-abc'),
      initiateDirectPayment: jest
        .fn()
        .mockResolvedValue({ success: true, gatewayRef: 'gw-ref-123' }),
    } as unknown as CreditWalletContext['paymentService'],
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(balance),
    } as unknown as CreditWalletContext['walletService'],
  };
}

function makeStep1State(): BotState {
  return {
    flowId: FLOW_IDS.CREDIT_WALLET,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

function makeStep2State(): BotState {
  return {
    flowId: FLOW_IDS.CREDIT_WALLET,
    step: 2,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

describe('runCreditWalletFlow() - step 1 (amount selection)', () => {
  it('re-displays menu on unrecognized input', async () => {
    const ctx = makeCtx(3000);
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, 'blabla', workerProfile, ctx);
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('Recharger mon wallet');
    expect(result.clearState).toBeUndefined();
  });

  it('re-displays menu on empty input', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '', workerProfile, ctx);
    expect(result.nextState).toBeDefined();
    expect(result.reply[0]).toContain('Recharger');
  });

  it('selects preset amount "1" (1000 FCFA) and enters mobile money sub-flow', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '1', workerProfile, ctx);
    // mobile money subflow shows "Mobile Money" prompt
    expect(result.reply[0]).toContain('Mobile Money');
    expect(result.clearState).toBeUndefined();
  });

  it('selects preset amount "2" (2500 FCFA) and enters mobile money sub-flow', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '2', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });

  it('selects preset amount "3" (5000 FCFA) and enters mobile money sub-flow', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '3', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });

  it('selects preset amount "4" (10000 FCFA) and enters mobile money sub-flow', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '4', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });

  it('selects "5" (custom) and moves to step 2', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '5', workerProfile, ctx);
    expect(result.nextState?.step).toBe(2);
    expect(result.reply[0]).toContain('personnalisé');
    expect(result.clearState).toBeUndefined();
  });

  it('cancels on "0"', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '0', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('cancels on "annuler"', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, 'annuler', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('cancels on "menu"', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, 'menu', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('shows current balance in the amount menu', async () => {
    const ctx = makeCtx(12500);
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '', workerProfile, ctx);
    expect(result.reply[0]).toContain('12');
  });
});

describe('runCreditWalletFlow() - step 2 (custom amount)', () => {
  it('accepts a valid custom amount and enters mobile money sub-flow', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, '3500', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });

  it('accepts a minimum-boundary amount (500)', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, '500', workerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });

  it('rejects an amount below minimum (499)', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, '499', workerProfile, ctx);
    expect(result.reply[0]).toContain('minimum');
    expect(result.nextState).toBe(state);
    expect(result.clearState).toBeUndefined();
  });

  it('rejects an amount above maximum (500001)', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, '500001', workerProfile, ctx);
    expect(result.reply[0]).toContain('maximum');
    expect(result.nextState).toBe(state);
  });

  it('rejects non-numeric input', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, 'abc', workerProfile, ctx);
    expect(result.reply[0]).toContain('invalide');
    expect(result.nextState).toBe(state);
  });

  it('cancels on "0"', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, '0', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('cancels on "annuler"', async () => {
    const ctx = makeCtx();
    const state = makeStep2State();
    const result = await runCreditWalletFlow(state, 'annuler', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });
});

describe('runCreditWalletFlow() - mobile money sub-flow continuation', () => {
  it('continues when _mm_step is present with "3" (web payment link)', async () => {
    const state: BotState = {
      flowId: FLOW_IDS.CREDIT_WALLET,
      step: 1,
      payload: {
        amount: 5000,
        _mm_step: 'use_registered_number',
        _mm_amount: 5000,
        _mm_description: 'Recharge du wallet — 5 000 FCFA',
        _mm_requestType: 'WALLET_TOP_UP',
        _mm_options: {},
      },
      updatedAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const result = await runCreditWalletFlow(state, '3', workerProfile, ctx);
    expect(result.clearState).toBe(true);
  });

  it('moves to enter_phone step when user picks "2" (other number)', async () => {
    const state: BotState = {
      flowId: FLOW_IDS.CREDIT_WALLET,
      step: 1,
      payload: {
        amount: 5000,
        _mm_step: 'use_registered_number',
        _mm_amount: 5000,
        _mm_description: 'Recharge du wallet — 5 000 FCFA',
        _mm_requestType: 'WALLET_TOP_UP',
        _mm_options: {},
      },
      updatedAt: new Date().toISOString(),
    };
    const ctx = makeCtx();
    const result = await runCreditWalletFlow(state, '2', workerProfile, ctx);
    expect(result.nextState?.payload?._mm_step).toBe('enter_phone');
  });
});

describe('runCreditWalletFlow() - employer profile', () => {
  it('shows the amount menu for employer too', async () => {
    const ctx = makeCtx(8000);
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '', employerProfile, ctx);
    expect(result.reply[0]).toContain('Recharger');
  });

  it('employer can select preset amount and proceed', async () => {
    const ctx = makeCtx();
    const state = makeStep1State();
    const result = await runCreditWalletFlow(state, '1', employerProfile, ctx);
    expect(result.reply[0]).toContain('Mobile Money');
  });
});

describe('getCreditWalletInitialState()', () => {
  it('returns correct initial state', async () => {
    const ctx = makeCtx(7500);
    const { state, message } = await getCreditWalletInitialState(workerProfile, ctx);
    expect(state.flowId).toBe(FLOW_IDS.CREDIT_WALLET);
    expect(state.step).toBe(1);
    expect(state.payload).toEqual({});
    expect(message).toContain('Recharger');
    expect(message).toContain('7');
  });

  it('displays current balance in initial message', async () => {
    const ctx = makeCtx(15000);
    const { message } = await getCreditWalletInitialState(workerProfile, ctx);
    expect(message).toContain('15');
  });
});
