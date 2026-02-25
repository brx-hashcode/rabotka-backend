import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type AcceptRefuseContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type StepArgs = {
  state: BotState;
  applicationId: string;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: AcceptRefuseContext;
};

async function handleAcceptRefuseStep1(args: StepArgs): Promise<FlowResult> {
  const { state, applicationId, normalized, profile, ctx } = args;
  if (!args.trimmed) {
    return {
      reply: [
        'Actions disponibles pour cette candidature:',
        '1️⃣ Accepter le candidat',
        '2️⃣ Refuser',
        '',
        'Tapez 1 ou 2.',
      ],
      nextState: state,
    };
  }
  if (normalized === '1' || normalized === 'accepter') {
    try {
      await ctx.applicationService.accept(applicationId, profile.id);
      await ctx.notificationService.sendApplicationAcceptedToWorker(
        applicationId,
      );
      return {
        reply: [
          '✅ Candidature acceptée !',
          '',
          'Le worker a été notifié. Vous pouvez le contacter directement via les coordonnées fournies.',
          '',
          "Votre offre est maintenant marquée comme pourvue. Tapez 'Menu' pour revenir.",
        ],
        clearState: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Impossible d'accepter.";
      return { reply: [`❌ ${message}`], nextState: state };
    }
  }
  if (normalized === '2' || normalized === 'refuser') {
    return {
      reply: [
        "Raison du refus ? (optionnel). Tapez la raison ou 'Aucune' pour refuser sans raison.",
      ],
      nextState: {
        ...state,
        step: 2,
        payload: { ...state.payload },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  return {
    reply: ['Répondez par 1 (Accepter) ou 2 (Refuser).'],
    nextState: state,
  };
}

async function handleAcceptRefuseStep2(args: StepArgs): Promise<FlowResult> {
  const { state, applicationId, trimmed, normalized, profile, ctx } = args;
  const reason =
    normalized === 'aucune' || normalized === 'non' ? undefined : trimmed;
  try {
    await ctx.applicationService.reject(
      applicationId,
      profile.id,
      reason ?? undefined,
    );
    await ctx.notificationService.sendApplicationRejectedToWorker(
      applicationId,
    );
    return {
      reply: [
        '❌ Candidature refusée',
        '',
        "Le worker a été notifié poliment. Votre offre reste ouverte pour d'autres candidatures.",
        '',
        "Tapez 'Menu' pour revenir.",
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Impossible de refuser.';
    return { reply: [`❌ ${message}`], nextState: state };
  }
}

export async function runAcceptRefuseCandidateFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: AcceptRefuseContext,
): Promise<FlowResult> {
  const payload = state.payload;
  const applicationId =
    typeof payload.applicationId === 'string'
      ? payload.applicationId
      : undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (!applicationId) {
    return {
      reply: ["Erreur: candidature non trouvée. Tapez 'Menu'."],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'EMPLOYER') {
    return {
      reply: [
        "Seuls les employeurs peuvent gérer les candidatures. Tapez 'Menu'.",
      ],
      clearState: true,
    };
  }

  const args: StepArgs = {
    state,
    applicationId,
    trimmed,
    normalized,
    profile,
    ctx,
  };

  if (state.step === 1) return handleAcceptRefuseStep1(args);
  if (state.step === 2) return handleAcceptRefuseStep2(args);

  return {
    reply: ["Erreur. Tapez 'Menu' pour revenir."],
    clearState: true,
  };
}

export function getAcceptRefuseInitialState(applicationId: string): BotState {
  return {
    flowId: FLOW_IDS.ACCEPT_REFUSE_CANDIDATE,
    step: 1,
    payload: { applicationId },
    updatedAt: new Date().toISOString(),
  };
}
