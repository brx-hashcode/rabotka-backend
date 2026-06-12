import {
  runProfileSubmenuFlow,
  getProfileSubmenuInitialState,
} from '../profile-submenu.flow';
import type { BotProfile } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'w-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
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

function makeWorkerState() {
  return getProfileSubmenuInitialState('WORKER');
}

function makeEmployerState() {
  return getProfileSubmenuInitialState('EMPLOYER');
}

function makeCtx() {
  return {
    commands: {
      penaltyHistory: jest.fn().mockResolvedValue('Historique'),
    } as any,
  };
}

describe('runProfileSubmenuFlow()', () => {
  describe('worker', () => {
    it('"1" calls penaltyHistory and clears state', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(ctx.commands.penaltyHistory).toHaveBeenCalledWith(workerProfile);
      expect(result.reply[0]).toBe('Historique');
      expect(result.clearState).toBe(true);
    });

    it('"2" goes to menu', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        '2',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/Menu Rabotka/i);
    });

    it('"menu" goes to menu', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        'menu',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('unknown input re-prompts without clearing state', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        'xyz',
        workerProfile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });
  });

  describe('employer', () => {
    it('"1" calls penaltyHistory and clears state', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        '1',
        employerProfile,
        ctx,
      );
      expect(ctx.commands.penaltyHistory).toHaveBeenCalledWith(employerProfile);
      expect(result.clearState).toBe(true);
    });

    it('"2" goes to menu', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        '2',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/Menu Rabotka/i);
    });

    it('"retour" exits to menu', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        'retour',
        employerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });
  });
});

describe('getProfileSubmenuInitialState()', () => {
  it('creates worker state with correct flowId', () => {
    const state = getProfileSubmenuInitialState('WORKER');
    expect(state.flowId).toBe(FLOW_IDS.PROFILE_SUBMENU);
    expect(state.payload?.profileType).toBe('WORKER');
  });

  it('creates employer state', () => {
    const state = getProfileSubmenuInitialState('EMPLOYER');
    expect(state.payload?.profileType).toBe('EMPLOYER');
  });
});
