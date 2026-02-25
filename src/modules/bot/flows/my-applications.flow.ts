import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import {
  getCancelApplicationInitialState,
  runCancelApplicationFlow,
} from './cancel-application.flow';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type MyApplicationsContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runMyApplicationsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const applicationIds = (payload.applicationIds as string[]) ?? [];
  const currentIndex = (payload.currentIndex as number) ?? 0;
  const trimmed = input.trim();

  if (applicationIds.length === 0) {
    return {
      reply: ["Aucune candidature. Tapez 'Menu'."],
      clearState: true,
    };
  }

  const applicationId = applicationIds[currentIndex];
  if (!applicationId) {
    return {
      reply: ["Index invalide. Tapez 'Menu'."],
      clearState: true,
    };
  }

  // "1" = Annuler cette candidature -> start cancel_application flow
  if (trimmed === '1') {
    const cancelState = getCancelApplicationInitialState(applicationId);
    const result = await runCancelApplicationFlow(
      cancelState,
      '',
      profile,
      ctx,
    );
    return {
      reply: result.reply,
      nextState: result.nextState ?? cancelState,
    };
  }

  // "2" or "4" = Menu
  if (trimmed === '2' || trimmed === '4') {
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }

  return {
    reply: [
      'Répondez par 1 (Annuler cette candidature) ou 2 (Retour au menu).',
    ],
    nextState: state,
  };
}

export function getMyApplicationsInitialState(
  applicationIds: string[],
): BotState {
  return {
    flowId: FLOW_IDS.MY_APPLICATIONS,
    step: 0,
    payload: { applicationIds, currentIndex: 0 },
    updatedAt: new Date().toISOString(),
  };
}
