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

describe('BotRouterService', () => {
  let service: BotRouterService;

  beforeEach(() => {
    service = new BotRouterService();
  });

  describe('when state has a flowId', () => {
    it('returns flow type with the current state', () => {
      const state = makeState(FLOW_IDS.PUBLISH_JOB);
      const result = service.route('hello', workerProfile, state);
      expect(result).toEqual({
        type: 'flow',
        flowId: FLOW_IDS.PUBLISH_JOB,
        state,
      });
    });

    it('routes exact "menu" to menu command so user can exit publish flow', () => {
      const state = makeState(FLOW_IDS.PUBLISH_JOB);
      const result = service.route('menu', workerProfile, state);
      expect(result).toEqual({ type: 'command', commandId: 'menu' });
    });

    it('strips LRM before menu so WhatsApp-prefixed Menu exits flow', () => {
      const state = makeState(FLOW_IDS.PUBLISH_JOB);
      const result = service.route('\u200eMenu', workerProfile, state);
      expect(result).toEqual({ type: 'command', commandId: 'menu' });
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

    it('routes "payer" to pay_penalties for employer (employers can have penalties too)', () => {
      const result = service.route('payer', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'pay_penalties' });
    });

    it('routes "PAYER" to pay_penalties even with an active flow state', () => {
      const state = {
        flowId: 'some_flow',
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      const result = service.route('PAYER', employerProfile, state);
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
      expect(result).toEqual({
        type: 'command',
        commandId: 'start_publish_job',
      });
    });

    it('routes "candidatures" to candidatures_received for employer', () => {
      const result = service.route('candidatures', employerProfile, null);
      expect(result).toEqual({
        type: 'command',
        commandId: 'candidatures_received',
      });
    });

    it('does not route "publier" for worker', () => {
      const result = service.route('publier', workerProfile, null);
      expect(result.type).not.toBe('command');
    });
  });

  describe('numeric menu options', () => {
    it('routes worker "2" to my_applications', () => {
      const result = service.route('2', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'my_applications' });
    });

    it('routes worker "3" to recommended_jobs', () => {
      const result = service.route('3', workerProfile, null);
      expect(result).toEqual({
        type: 'command',
        commandId: 'recommended_jobs',
      });
    });

    it('routes worker "4" to search_by_ref', () => {
      const result = service.route('4', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'search_by_ref' });
    });

    it('routes worker "5" to profile', () => {
      const result = service.route('5', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'profile' });
    });

    it('routes worker "6" to credit_wallet', () => {
      const result = service.route('6', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
    });

    it('routes worker "7" to create_claim', () => {
      const result = service.route('7', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'create_claim' });
    });

    it('routes worker "8" to help', () => {
      const result = service.route('8', workerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'help' });
    });

    it('routes employer "2" to candidatures_received', () => {
      const result = service.route('2', employerProfile, null);
      expect(result).toEqual({
        type: 'command',
        commandId: 'candidatures_received',
      });
    });

    it('routes employer "3" to my_offers', () => {
      const result = service.route('3', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'my_offers' });
    });

    it('routes employer "7" to credit_wallet', () => {
      const result = service.route('7', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'credit_wallet' });
    });

    it('routes employer "8" to create_claim', () => {
      const result = service.route('8', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'create_claim' });
    });

    it('routes employer "9" to help', () => {
      const result = service.route('9', employerProfile, null);
      expect(result).toEqual({ type: 'command', commandId: 'help' });
    });

    it('routes the "réclamation" alias to create_claim for both profiles', () => {
      expect(service.route('réclamation', workerProfile, null)).toEqual({
        type: 'command',
        commandId: 'create_claim',
      });
      expect(service.route('reclamation', employerProfile, null)).toEqual({
        type: 'command',
        commandId: 'create_claim',
      });
    });

    it('text alias "historique" still routes to penalty_history', () => {
      expect(service.route('historique', workerProfile, null)).toEqual({
        type: 'command',
        commandId: 'penalty_history',
      });
      expect(service.route('historique', employerProfile, null)).toEqual({
        type: 'command',
        commandId: 'penalty_history',
      });
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
