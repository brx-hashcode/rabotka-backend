import { BotRouterService } from '../bot-router.service';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'w-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
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

describe('BotRouterService', () => {
  let service: BotRouterService;

  beforeEach(() => {
    service = new BotRouterService();
  });

  describe('when state has a flowId', () => {
    it('returns flow type with the current state', () => {
      const state = makeState(FLOW_IDS.PUBLISH_JOB);
      const result = service.route('hello', workerProfile, state);
      expect(result).toEqual({ type: 'flow', flowId: FLOW_IDS.PUBLISH_JOB, state });
    });
  });

  describe('menu commands', () => {
    it('routes "menu" to menu command', () => {
      const result = service.route('menu', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'menu' });
    });

    it('routes "Menu" (case-insensitive) to menu command', () => {
      const result = service.route('Menu', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'menu' });
    });
  });

  describe('worker commands', () => {
    it('routes "offres" to list_offers for worker', () => {
      const result = service.route('offres', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'list_offers' });
    });

    it('routes "payer" to pay_penalties for worker', () => {
      const result = service.route('payer', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'pay_penalties' });
    });

    it('does not route "offres" to list_offers for employer', () => {
      const result = service.route('offres', employerProfile, null);
      // employers can't list_offers
      expect(result).not.toEqual({ type: 'command', commandId: 'list_offers' });
    });
  });

  describe('employer commands', () => {
    it('routes "publier" to start_publish_job for employer', () => {
      const result = service.route('publier', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'start_publish_job' });
    });

    it('routes "candidatures" to candidatures_received for employer', () => {
      const result = service.route('candidatures', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'candidatures_received' });
    });

    it('does not route "publier" for worker', () => {
      const result = service.route('publier', workerProfile, null);
      expect(result.type).not.toBe('command');
    });
  });

  describe('numeric menu options', () => {
    it('routes worker numeric option for profile', () => {
      // WORKER_MENU_OPTIONS.PROFILE
      const result = service.route('3', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'profile' });
    });

    it('routes employer numeric option for my_offers', () => {
      // EMPLOYER_MENU_OPTIONS.MY_OFFERS
      const result = service.route('2', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'my_offers' });
    });
  });

  describe('unknown input', () => {
    it('returns unknown for unrecognized input', () => {
      const result = service.route('random garbage', workerProfile, null);
      expect(result).toEqual({ type: 'unknown' });
    });
  });

  describe('profile command', () => {
    it('routes "profil" for both worker and employer', () => {
      expect(service.route('profil', workerProfile, null)).toEqual({
        type: 'command',
        commandId: 'profile',
      });
      expect(service.route('profil', employerProfile, null)).toEqual({
        type: 'command',
        commandId: 'profile',
      });
    });
  });
});
