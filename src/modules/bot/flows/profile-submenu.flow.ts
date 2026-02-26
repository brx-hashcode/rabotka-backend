import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { BotCommandsService } from '../services/bot-commands.service';
import { getCandidaturesListInitialState } from './candidatures-list.flow';

export type ProfileSubmenuContext = {
  commands: BotCommandsService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runProfileSubmenuFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ProfileSubmenuContext,
): Promise<FlowResult> {
  const payload = state.payload ?? {};
  const profileType =
    (payload.profileType as 'WORKER' | 'EMPLOYER') ?? profile.profile_type;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profileType)],
    clearState: true,
  });

  if (
    trimmed === '3' ||
    normalized === 'retour' ||
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  if (profileType === 'EMPLOYER') {
    if (trimmed === '1') {
      const message = await ctx.commands.myOffers(profile);
      return { reply: [message], clearState: true };
    }
    if (trimmed === '2') {
      const result = await ctx.commands.candidaturesReceived(profile);
      if (result.items?.length) {
        return {
          reply: [result.message],
          nextState: getCandidaturesListInitialState(result.items),
        };
      }
      return { reply: [result.message], clearState: true };
    }
  }

  if (profileType === 'WORKER') {
    if (trimmed === '1') {
      const result = await ctx.commands.myApplications(profile);
      return { reply: [result.message], clearState: true };
    }
    if (trimmed === '2') {
      const message = await ctx.commands.penaltyHistory(profile);
      return { reply: [message], clearState: true };
    }
  }

  return {
    reply: ["Tapez 1, 2 ou 3 (ou 'Menu') pour continuer."],
    nextState: state,
  };
}

export function getProfileSubmenuInitialState(
  profileType: 'WORKER' | 'EMPLOYER',
): BotState {
  return {
    flowId: FLOW_IDS.PROFILE_SUBMENU,
    step: 0,
    payload: { profileType },
    updatedAt: new Date().toISOString(),
  };
}
