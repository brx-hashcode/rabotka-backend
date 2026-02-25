import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import {
  formatCancelApplicationNoPenalty,
  formatCancelApplicationWithPenalty,
} from '../messages/penalty.messages';
import {
  LATE_CANCELLATION_PENALTY_FCFA,
  LATE_CANCELLATION_SCORE_DEDUCTION,
} from '../../application/application.constants';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type CancelApplicationContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type CancelStepArgs = {
  state: BotState;
  payload: Record<string, unknown>;
  applicationId: string;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: CancelApplicationContext;
};

type AppWithOffer = {
  id: string;
  worker_id: string;
  status: string;
  job_offer: {
    title: string;
    scheduled_at: Date;
    amount: number;
  };
};

function formatTimeRemaining(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days} jour(s) ${hours % 24}h`;
  }
  return `${hours} heure(s) ${minutes} min`;
}

async function handleCancelStep1(
  args: CancelStepArgs,
  app: AppWithOffer,
  isLate: boolean,
  timeRemainingStr: string,
): Promise<FlowResult> {
  const { state, payload, applicationId, trimmed, normalized, profile, ctx } =
    args;
  const scheduledAt = app.job_offer.scheduled_at;

  if (!trimmed) {
    if (isLate) {
      const newScore = Math.max(
        50,
        (profile.reliability_score ?? 100) - LATE_CANCELLATION_SCORE_DEDUCTION,
      );
      const text = formatCancelApplicationWithPenalty({
        offerTitle: app.job_offer.title,
        scheduledAt,
        amount: app.job_offer.amount,
        timeRemaining: timeRemainingStr,
        penaltyAmount: LATE_CANCELLATION_PENALTY_FCFA,
        scoreDeduction: LATE_CANCELLATION_SCORE_DEDUCTION,
        newScore,
      });
      return { reply: [text], nextState: state };
    }
    const text = formatCancelApplicationNoPenalty({
      offerTitle: app.job_offer.title,
      scheduledAt,
      amount: app.job_offer.amount,
      timeRemaining: timeRemainingStr,
    });
    return { reply: [text], nextState: state };
  }

  const reason = normalized === 'confirmer' ? undefined : trimmed;
  if (isLate && !reason) {
    return {
      reply: [
        '*La raison est obligatoire pour une annulation tardive. Tapez votre raison.*',
      ],
      nextState: state,
    };
  }

  if (isLate) {
    return {
      reply: [
        [
          '*Êtes-vous certain de vouloir annuler ?*',
          `*Pénalité*: ${LATE_CANCELLATION_PENALTY_FCFA.toLocaleString('fr-FR')} FCFA`,
          '1️⃣ Oui, annuler malgré la pénalité',
          '2️⃣ Non, maintenir ma candidature',
          '',
          '*Tapez 1 ou 2.*',
        ].join('\n'),
      ],
      nextState: {
        ...state,
        step: 2,
        payload: { ...payload, reason },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  try {
    const result = await ctx.applicationService.cancel(
      applicationId,
      profile.id,
      reason ?? undefined,
    );
    await ctx.notificationService.sendCancellationToEmployer(
      applicationId,
      result.application.cancellation_reason ?? null,
      false,
    );
    return {
      reply: [
        [
          '*Candidature annulée*',
          '',
          "Votre candidature a été annulée. L'employeur a été notifié.",
          '',
          "*Tapez 'Menu' pour revenir.*",
        ].join('\n'),
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "*IMPOSSIBLE D'ANNULER.*";
    return { reply: [`❌ ${message}`], nextState: state };
  }
}

async function handleCancelStep2(args: CancelStepArgs): Promise<FlowResult> {
  const { state, payload, applicationId, normalized, profile, ctx } = args;
  if (normalized === '1' || normalized === 'oui') {
    const reason = (payload.reason as string) ?? undefined;
    try {
      const result = await ctx.applicationService.cancel(
        applicationId,
        profile.id,
        reason,
      );
      await ctx.notificationService.sendCancellationToEmployer(
        applicationId,
        reason ?? null,
        true,
      );
      const penaltyMsg = result.penaltyAmount
        ? `\nUne pénalité de ${result.penaltyAmount.toLocaleString('fr-FR')} FCFA a été appliquée.`
        : '';
      return {
        reply: [
          [
            '*Candidature annulée avec pénalité*',
            '',
            'Votre candidature a été annulée.' + penaltyMsg,
            '',
            "L'employeur a été notifié.",
            '',
            "Tapez 'Menu' pour revenir.",
          ].join('\n'),
        ],
        clearState: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "*IMPOSSIBLE D'ANNULER.*";
      return { reply: [`❌ ${message}`], nextState: state };
    }
  }
  if (normalized === '2' || normalized === 'non') {
    return {
      reply: [
        "*Annulation annulée. Votre candidature est maintenue. Tapez 'Menu'.*",
      ],
      clearState: true,
    };
  }
  return {
    reply: ['*RÉPONDEZ PAR 1 (OUI, ANNULER) OU 2 (NON, MAINTENIR).*'],
    nextState: state,
  };
}

export async function runCancelApplicationFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: CancelApplicationContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const applicationId = payload.applicationId as string | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (!applicationId) {
    return {
      reply: ["*ERREUR: CANDIDATURE NON TROUVÉE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: [
        "*SEULS LES WORKERS PEUVENT ANNULER LEURS CANDIDATURES. TAPEZ 'MENU'.*",
      ],
      clearState: true,
    };
  }

  const app = await ctx.applicationService.findById(applicationId);
  if (!app || app.worker_id !== profile.id) {
    return {
      reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  if (app.status !== 'PENDING' && app.status !== 'ACCEPTED') {
    return {
      reply: ["*CETTE CANDIDATURE NE PEUT PLUS ÊTRE ANNULÉE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const now = new Date();
  const scheduledAt = app.job_offer.scheduled_at;
  const msUntil = scheduledAt.getTime() - now.getTime();
  const hoursUntil = msUntil / (60 * 60 * 1000);
  const isLate = hoursUntil < 4 && hoursUntil >= 0;
  const timeRemainingStr = formatTimeRemaining(msUntil);

  const stepArgs: CancelStepArgs = {
    state,
    payload,
    applicationId,
    trimmed,
    normalized,
    profile,
    ctx,
  };

  if (state.step === 1) {
    return handleCancelStep1(
      stepArgs,
      app as AppWithOffer,
      isLate,
      timeRemainingStr,
    );
  }
  if (state.step === 2) return handleCancelStep2(stepArgs);

  return {
    reply: ["*ERREUR. TAPEZ 'MENU'.*"],
    clearState: true,
  };
}

export function getCancelApplicationInitialState(
  applicationId: string,
): BotState {
  return {
    flowId: FLOW_IDS.CANCEL_APPLICATION,
    step: 1,
    payload: { applicationId },
    updatedAt: new Date().toISOString(),
  };
}
