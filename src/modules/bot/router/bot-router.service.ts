import { Injectable } from '@nestjs/common';
import type { BotState, BotProfile } from '../types/bot-state.types';
import {
  WORKER_MENU_OPTIONS,
  EMPLOYER_MENU_OPTIONS,
  CMD_MENU,
  CMD_PUBLISH,
  CMD_MY_OFFERS,
  CMD_CANDIDATURES,
  CMD_FILLED_JOBS,
  CMD_PROFILE,
  CMD_HISTORY,
  CMD_LIST_OFFERS,
  CMD_PAY,
  CMD_UNLOCK,
  CMD_RECOMMENDED_JOBS,
  CMD_RECOMMENDED_PROFILES,
} from '../bot.constants';
import { stripChatFormattingChars } from '../utils/chat-input';

export type RouteResult =
  | { type: 'flow'; flowId: string; state: BotState }
  | { type: 'command'; commandId: string }
  | { type: 'unknown' };

function matchCommandAlias(
  normalized: string,
  isWorker: boolean,
  isEmployer: boolean,
): string | null {
  const isMenu =
    CMD_MENU.includes(normalized) ||
    CMD_MENU.some((c) => normalized.startsWith(c + ' '));
  if (isMenu) return 'menu';
  if (CMD_PUBLISH.includes(normalized) && isEmployer)
    return 'start_publish_job';
  if (CMD_MY_OFFERS.includes(normalized) && isEmployer) return 'my_offers';
  if (CMD_CANDIDATURES.includes(normalized) && isEmployer)
    return 'candidatures_received';
  if (CMD_FILLED_JOBS.includes(normalized) && isEmployer) return 'filled_jobs';
  if (CMD_PROFILE.includes(normalized)) return 'profile';
  if (CMD_HISTORY.includes(normalized)) return 'penalty_history';
  if (CMD_LIST_OFFERS.includes(normalized) && isWorker) return 'list_offers';
  if (CMD_PAY.includes(normalized) && isWorker) return 'pay_penalties';
  if (CMD_UNLOCK.includes(normalized)) return 'unlock_contact';
  if (CMD_RECOMMENDED_JOBS.includes(normalized) && isWorker) return 'recommended_jobs';
  if (CMD_RECOMMENDED_PROFILES.includes(normalized) && isEmployer) return 'recommended_profiles';
  return null;
}

function matchWorkerNumeric(trimmed: string): string | null {
  if (trimmed === WORKER_MENU_OPTIONS.LIST_OFFERS) return 'list_offers';
  if (trimmed === WORKER_MENU_OPTIONS.MY_APPLICATIONS) return 'my_applications';
  if (trimmed === WORKER_MENU_OPTIONS.RECOMMENDED_JOBS) return 'recommended_jobs';
  if (trimmed === WORKER_MENU_OPTIONS.PROFILE) return 'profile';
  if (trimmed === WORKER_MENU_OPTIONS.HISTORY) return 'penalty_history';
  if (trimmed === WORKER_MENU_OPTIONS.HELP) return 'help';
  return null;
}

function matchEmployerNumeric(trimmed: string): string | null {
  if (trimmed === EMPLOYER_MENU_OPTIONS.PUBLISH_OFFER)
    return 'start_publish_job';
  if (trimmed === EMPLOYER_MENU_OPTIONS.MY_OFFERS) return 'my_offers';
  if (trimmed === EMPLOYER_MENU_OPTIONS.CANDIDATURES_RECEIVED)
    return 'candidatures_received';
  if (trimmed === EMPLOYER_MENU_OPTIONS.FILLED_JOBS) return 'filled_jobs';
  if (trimmed === EMPLOYER_MENU_OPTIONS.RECOMMENDED_PROFILES) return 'recommended_profiles';
  if (trimmed === EMPLOYER_MENU_OPTIONS.PROFILE) return 'profile';
  if (trimmed === EMPLOYER_MENU_OPTIONS.HISTORY) return 'penalty_history';
  if (trimmed === EMPLOYER_MENU_OPTIONS.HELP) return 'help';
  return null;
}

@Injectable()
export class BotRouterService {
  route(
    input: string,
    profile: BotProfile,
    state: BotState | null,
  ): RouteResult {
    const trimmed = stripChatFormattingChars(input.trim());
    const normalized = trimmed.toLowerCase();
    const isWorker = profile.profile_type === 'WORKER';
    const isEmployer = profile.profile_type === 'EMPLOYER';

    // Exact menu keywords (not "menu …" phrases) exit any flow so users can
    // always reach the main menu (e.g. publish-job / accept-refuse had no CMD_MENU).
    if (state?.flowId && CMD_MENU.includes(normalized)) {
      return { type: 'command', commandId: 'menu' };
    }

    if (state?.flowId) {
      return { type: 'flow', flowId: state.flowId, state };
    }

    const aliasCmd = matchCommandAlias(normalized, isWorker, isEmployer);
    if (aliasCmd) return { type: 'command', commandId: aliasCmd };

    if (isWorker) {
      const workerCmd = matchWorkerNumeric(trimmed);
      if (workerCmd) return { type: 'command', commandId: workerCmd };
    }
    if (isEmployer) {
      const employerCmd = matchEmployerNumeric(trimmed);
      if (employerCmd) return { type: 'command', commandId: employerCmd };
    }

    return { type: 'unknown' };
  }
}
