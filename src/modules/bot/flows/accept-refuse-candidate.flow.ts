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
  const { state, normalized, trimmed } = args;
  const reason =
    normalized === 'aucune' || normalized === '0' || normalized === 'non'
      ? null
      : trimmed;

  // Store reason in payload and move to confirmation step
  return {
    reply: [
      [
        '*Confirmer le refus ?*',
        '',
        reason ? `Raison : ${reason}` : 'Aucune raison fournie.',
        '',
        '1️⃣ Oui, refuser le candidat',
        '2️⃣ Annuler (garder la candidature en attente)',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 3,
      payload: { ...state.payload, refusalReason: reason ?? '' },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleAcceptRefuseStep3(args: StepArgs): Promise<FlowResult> {
  const { state, applicationId, normalized, profile, ctx } = args;

  if (normalized === '2' || normalized === 'annuler') {
    return {
      reply: [
        "*Refus annulé.* La candidature reste en attente.\n\nTapez 'Menu' pour revenir.",
      ],
      clearState: true,
    };
  }

  if (normalized !== '1' && normalized !== 'oui') {
    return {
      reply: ['*Répondez par 1 (confirmer le refus) ou 2 (annuler).*'],
      nextState: state,
    };
  }

  const reason =
    typeof state.payload.refusalReason === 'string' &&
    state.payload.refusalReason.length > 0
      ? state.payload.refusalReason
      : undefined;

  try {
    await ctx.applicationService.reject(applicationId, profile.id, reason);
    await ctx.notificationService.sendApplicationRejectedToWorker(applicationId);
    return {
      reply: [
        [
          '*Candidature refusée.*',
          '',
          "Le candidat a été notifié. Votre offre reste ouverte pour d'autres candidatures.",
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
  if (state.step === 3) return handleAcceptRefuseStep3(args);

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
