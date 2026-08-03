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

  describe('when a flow is live', () => {
    it('hands the input to the active flow', () => {
      const state = makeState(FLOW_IDS.PAY_PENALTIES);

      expect(service.route('hello', workerProfile, state)).toEqual({
        type: 'flow',
        flowId: FLOW_IDS.PAY_PENALTIES,
        state,
      });
    });

    it.each(['payer', 'PAYER', 'Payer'])(
      'lets %p escape into pay_penalties',
      (input) => {
        expect(
          service.route(input, workerProfile, makeState(FLOW_IDS.PAY_PENALTIES)),
        ).toEqual({ type: 'command', commandId: 'pay_penalties' });
      },
    );

    it('strips WhatsApp formatting characters before matching the escape', () => {
      expect(
        service.route(
          '‎payer',
          workerProfile,
          makeState(FLOW_IDS.PAY_PENALTIES),
        ),
      ).toEqual({ type: 'command', commandId: 'pay_penalties' });
    });
  });

  describe('with no live flow — the menu is retired', () => {
    // Each of these used to open a flow from chat. Those journeys live in the
    // app now, so the orchestrator answers every one with the welcome card.
    it.each([
      'menu',
      'MENU',
      '‎Menu',
      'aide',
      'bonjour',
      '1',
      '2',
      '9',
      'publier',
      'candidatures',
      'mes offres',
      'profil',
      'débloquer',
      'reclamation',
      'bonjour, je cherche du travail',
      '',
    ])('routes %p as unknown', (input) => {
      expect(service.route(input, workerProfile, null)).toEqual({
        type: 'unknown',
      });
    });

    it.each(['1', '5', 'publier', 'menu'])(
      'routes employer input %p as unknown too',
      (input) => {
        expect(service.route(input, employerProfile, null)).toEqual({
          type: 'unknown',
        });
      },
    );
  });
});
