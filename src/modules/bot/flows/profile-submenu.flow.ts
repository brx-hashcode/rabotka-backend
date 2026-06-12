import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { BotCommandsService } from '../services/bot-commands.service';

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
    trimmed === '2' ||
    normalized === 'retour' ||
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  if (trimmed === '1') {
    const message = await ctx.commands.penaltyHistory(profile);
    return { reply: [message], clearState: true };
  }

  return {
    reply: ['*Tapez le numéro correspondant.*'],
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
