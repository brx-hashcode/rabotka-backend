import { BotRouterService } from '../bot-router.service';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import {
  CMD_NAVIGATION,
  CMD_RESUME,
  CMD_STOP,
  FLOW_IDS,
} from '../../bot.constants';

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
      'answers %p with the payment card command',
      (input) => {
        expect(
          service.route(
            input,
            workerProfile,
            makeState(FLOW_IDS.PAY_PENALTIES),
          ),
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

  describe('« payer » with no live flow', () => {
    // Older reminders told people to type it; it now opens the app.
    it.each(['payer', 'régler', 'payer penalites'])(
      'routes %p to pay_penalties',
      (input) => {
        expect(service.route(input, workerProfile, null)).toEqual({
          type: 'command',
          commandId: 'pay_penalties',
        });
      },
    );
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

  describe('the marketing opt-out pair', () => {
    it.each(CMD_STOP)('routes %p to marketing_opt_out', (input) => {
      expect(service.route(input, workerProfile, null)).toEqual({
        type: 'command',
        commandId: 'marketing_opt_out',
      });
    });

    it.each(CMD_RESUME)('routes %p to marketing_opt_in', (input) => {
      expect(service.route(input, workerProfile, null)).toEqual({
        type: 'command',
        commandId: 'marketing_opt_in',
      });
    });
  });

  describe('the front door is not an opt-in', () => {
    // The regression this guards: « start » was listed in CMD_RESUME, which the
    // router checks before everything else. `/start` expands to `start`, so the
    // documented way into the app answered « C’est réactivé » — a marketing
    // preference the user never asked to change — instead of the welcome card.
    it.each(['start', 'START', '‎Start', 'démarrer', 'commencer', 'menu'])(
      'leaves %p to the orchestrator rather than claiming it as a command',
      (input) => {
        expect(service.route(input, workerProfile, null)).toEqual({
          type: 'unknown',
        });
      },
    );

    it('still reaches a live flow, which owns the escape', () => {
      // Mid-flow is exactly when someone types it. The router hands it to the
      // open flow rather than claiming it, and the flow honours it as an escape
      // because `start` is in CMD_MENU — the behaviour that broke when the
      // opt-in branch started intercepting the word first.
      const state = makeState(FLOW_IDS.PAY_PENALTIES);

      expect(service.route('start', workerProfile, state)).toEqual({
        type: 'flow',
        flowId: FLOW_IDS.PAY_PENALTIES,
        state,
      });
    });

    // The structural version of the same bug: any word that means "show me the
    // thing" must never also mean "change my marketing preference".
    it('shares no word between the navigation and opt-out vocabularies', () => {
      const claimed = new Set([...CMD_STOP, ...CMD_RESUME]);
      expect(CMD_NAVIGATION.filter((c) => claimed.has(c))).toEqual([]);
    });
  });
});
