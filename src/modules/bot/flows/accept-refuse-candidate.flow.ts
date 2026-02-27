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
        [
          '*ACTIONS DISPONIBLES POUR CETTE CANDIDATURE:*',
          '1️⃣ Accepter le candidat',
          '2️⃣ Refuser',
          '',
          '*Tapez le numéro correspondant.*',
        ].join('\n'),
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
          [
            '*Candidature acceptée !*',
            '',
            'Le worker a été notifié. Vous pouvez le contacter directement via les coordonnées fournies.',
            '',
            "Votre offre est maintenant marquée comme pourvue. Tapez 'Menu' pour revenir.",
          ].join('\n'),
        ],
        clearState: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "*IMPOSSIBLE D'ACCEPTER.*";
      return { reply: [`❌ ${message}`], nextState: state };
    }
  }
  if (normalized === '2' || normalized === 'refuser') {
    return {
      reply: [
        [
          "*RAISON DU REFUS ? (OPTIONNEL). TAPEZ LA RAISON OU 'AUCUNE' POUR REFUSER SANS RAISON.*",
        ].join('\n'),
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
    reply: ['*RÉPONDEZ PAR 1 (ACCEPTER) OU 2 (REFUSER).*'],
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
        [
          '*Candidature refusée*',
          '',
          "Le worker a été notifié poliment. Votre offre reste ouverte pour d'autres candidatures.",
          '',
          "*Tapez 'Menu' pour revenir.*",
        ].join('\n'),
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : '*IMPOSSIBLE DE REFUSER.*';
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
      reply: ["*ERREUR: CANDIDATURE NON TROUVÉE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'EMPLOYER') {
    return {
      reply: [
        "*SEULS LES EMPLOYEURS PEUVENT GÉRER LES CANDIDATURES. TAPEZ 'MENU'.*",
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
    reply: ["*ERREUR. TAPEZ 'MENU' POUR REVENIR.*"],
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
