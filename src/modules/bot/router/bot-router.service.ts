import { Injectable } from '@nestjs/common';
import type { BotState, BotProfile } from '../types/bot-state.types';
import {
  WORKER_MENU_OPTIONS,
  EMPLOYER_MENU_OPTIONS,
  CMD_MENU,
  CMD_PUBLISH,
  CMD_MY_OFFERS,
  CMD_CANDIDATURES,
  CMD_PROFILE,
  CMD_HISTORY,
  CMD_LIST_OFFERS,
} from '../bot.constants';

export type RouteResult =
  | { type: 'flow'; flowId: string; state: BotState }
  | { type: 'command'; commandId: string }
  | { type: 'unknown' };

@Injectable()
export class BotRouterService {
  /**
   * Resolve the incoming message to either a flow (continue existing or start) or a command.
   */
  route(
    input: string,
    profile: BotProfile,
    state: BotState | null,
  ): RouteResult {
    const trimmed = input.trim();
    const normalized = trimmed.toLowerCase();
    const isWorker = profile.profile_type === 'WORKER';
    const isEmployer = profile.profile_type === 'EMPLOYER';

    // If we have an active flow, the orchestrator will pass to the flow handler; we only route when there's no flow or flow is list_offers and user chose an option
    if (state?.flowId) {
      // Let the orchestrator handle flow continuation
      return { type: 'flow', flowId: state.flowId, state };
    }

    // Command aliases
    if (
      CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
    ) {
      return { type: 'command', commandId: 'menu' };
    }
    if (CMD_PUBLISH.some((c) => normalized === c) && isEmployer) {
      return { type: 'command', commandId: 'start_publish_job' };
    }
    if (CMD_MY_OFFERS.some((c) => normalized === c) && isEmployer) {
      return { type: 'command', commandId: 'my_offers' };
    }
    if (CMD_CANDIDATURES.some((c) => normalized === c) && isEmployer) {
      return { type: 'command', commandId: 'candidatures_received' };
    }
    if (CMD_PROFILE.some((c) => normalized === c)) {
      return { type: 'command', commandId: 'profile' };
    }
    if (CMD_HISTORY.some((c) => normalized === c)) {
      return { type: 'command', commandId: 'penalty_history' };
    }
    if (CMD_LIST_OFFERS.some((c) => normalized === c) && isWorker) {
      return { type: 'command', commandId: 'list_offers' };
    }

    // Numeric menu options
    if (trimmed === WORKER_MENU_OPTIONS.LIST_OFFERS && isWorker) {
      return { type: 'command', commandId: 'list_offers' };
    }
    if (trimmed === WORKER_MENU_OPTIONS.MY_APPLICATIONS && isWorker) {
      return { type: 'command', commandId: 'my_applications' };
    }
    if (trimmed === WORKER_MENU_OPTIONS.PROFILE && isWorker) {
      return { type: 'command', commandId: 'profile' };
    }
    if (trimmed === WORKER_MENU_OPTIONS.HISTORY && isWorker) {
      return { type: 'command', commandId: 'penalty_history' };
    }
    if (trimmed === WORKER_MENU_OPTIONS.HELP && isWorker) {
      return { type: 'command', commandId: 'menu' };
    }

    if (trimmed === EMPLOYER_MENU_OPTIONS.PUBLISH_OFFER && isEmployer) {
      return { type: 'command', commandId: 'start_publish_job' };
    }
    if (trimmed === EMPLOYER_MENU_OPTIONS.MY_OFFERS && isEmployer) {
      return { type: 'command', commandId: 'my_offers' };
    }
    if (trimmed === EMPLOYER_MENU_OPTIONS.CANDIDATURES_RECEIVED && isEmployer) {
      return { type: 'command', commandId: 'candidatures_received' };
    }
    if (trimmed === EMPLOYER_MENU_OPTIONS.PROFILE && isEmployer) {
      return { type: 'command', commandId: 'profile' };
    }
    if (trimmed === EMPLOYER_MENU_OPTIONS.HISTORY && isEmployer) {
      return { type: 'command', commandId: 'penalty_history' };
    }
    if (trimmed === EMPLOYER_MENU_OPTIONS.HELP && isEmployer) {
      return { type: 'command', commandId: 'menu' };
    }

    return { type: 'unknown' };
  }
}
