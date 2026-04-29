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
      myApplications: jest
        .fn()
        .mockResolvedValue({ message: 'Mes candidatures' }),
      penaltyHistory: jest.fn().mockResolvedValue('Historique pénalités'),
      myOffers: jest.fn().mockResolvedValue('Mes offres'),
      candidaturesReceived: jest
        .fn()
        .mockResolvedValue({ message: 'Candidatures reçues', items: [] }),
    } as any,
  };
}

describe('runProfileSubmenuFlow()', () => {
  describe('worker', () => {
    it('exits to menu on "3"', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        '3',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toMatch(/MENU/i);
    });

    it('exits to menu on "menu"', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        'menu',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('shows my applications on "1"', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(ctx.commands.myApplications).toHaveBeenCalledWith(workerProfile);
      expect(result.reply[0]).toBe('Mes candidatures');
      expect(result.clearState).toBe(true);
    });

    it('shows penalty history on "2"', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeWorkerState(),
        '2',
        workerProfile,
        ctx,
      );
      expect(ctx.commands.penaltyHistory).toHaveBeenCalled();
      expect(result.clearState).toBe(true);
    });

    it('shows prompt for unknown input', async () => {
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
    it('shows my offers on "1"', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        '1',
        employerProfile,
        ctx,
      );
      expect(ctx.commands.myOffers).toHaveBeenCalledWith(employerProfile);
      expect(result.clearState).toBe(true);
    });

    it('shows candidatures received on "2" with no items', async () => {
      const ctx = makeCtx();
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        '2',
        employerProfile,
        ctx,
      );
      expect(ctx.commands.candidaturesReceived).toHaveBeenCalledWith(
        employerProfile,
      );
      expect(result.clearState).toBe(true);
    });

    it('transitions to candidatures list flow when items exist', async () => {
      const ctx = makeCtx();
      ctx.commands.candidaturesReceived.mockResolvedValue({
        message: 'Liste',
        items: [
          {
            id: 'app-1',
            fullName: 'Alice Dupont',
            firstName: 'Alice',
            lastName: 'Dupont',
            email: 'alice@example.com',
            score: 90,
            status: 'VERIFIED',
            offerTitle: 'Plombier',
          },
        ],
      });
      const result = await runProfileSubmenuFlow(
        makeEmployerState(),
        '2',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.flowId).toBe(FLOW_IDS.CANDIDATURES_LIST);
    });

    it('exits on "retour"', async () => {
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
