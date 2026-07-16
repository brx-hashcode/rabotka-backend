import { BotRouterService } from '../bot-router.service';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'w-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242061234567',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  id: 'e-1',
  profile_type: 'EMPLOYER',
};

function makeState(flowId: string): BotState {
  return {
    flowId,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

describe('BotRouterService — "recharger" command routing', () => {
  let service: BotRouterService;

  beforeEach(() => {
    service = new BotRouterService();
  });

  it('routes "recharger" to credit_wallet for worker', () => {
    const result = service.route('recharger', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "recharger" to credit_wallet for employer', () => {
    const result = service.route('recharger', employerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "Recharger" (case-insensitive) to credit_wallet', () => {
    const result = service.route('Recharger', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "RECHARGER" (uppercase) to credit_wallet', () => {
    const result = service.route('RECHARGER', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "recharger mon wallet" to credit_wallet', () => {
    const result = service.route('recharger mon wallet', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "recharge" to credit_wallet', () => {
    const result = service.route('recharge', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes "recharger portefeuille" to credit_wallet', () => {
    const result = service.route('recharger portefeuille', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes worker numeric "6" to credit_wallet', () => {
    const result = service.route('6', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('routes employer numeric "7" to credit_wallet', () => {
    const result = service.route('7', employerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
  });

  it('does NOT route "recharger" when in an active flow (flow takes priority)', () => {
    const state = makeState(FLOW_IDS.PUBLISH_JOB);
    const result = service.route('recharger', workerProfile, state);
    // Active flow — input should be sent to the flow, not treated as command
    expect(result).toEqual({
      type: 'flow',
      flowId: FLOW_IDS.PUBLISH_JOB,
      state,
    });
  });

  it('worker "8" now routes to help (shifted from 7 by create_claim)', () => {
    const result = service.route('8', workerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'help' });
  });

  it('employer "9" now routes to help (shifted from 8 by create_claim)', () => {
    const result = service.route('9', employerProfile, null);
    expect(result).toEqual({ type: 'command', commandId: 'help' });
  });
});
