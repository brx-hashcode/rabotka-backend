import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
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
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';
import { welcomePlatformMessage } from '../messages/welcome.messages';
import { closesOnFill } from '../../job-offer/utils/employment-type.util';

export type CancelApplicationContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  interestSignalService: InterestSignalService;
  cancellationThresholdHours: number;
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
  jobOfferId: string;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: CancelApplicationContext;
};

type AppWithOffer = {
  id: string;
  worker_id: string;
  status: string;
  job_offer_id: string;
  job_offer: {
    title: string;
    scheduled_at: Date | null;
    amount: number | null;
  };
};

function formatTimeRemaining(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} jour(s) ${hours % 24}h`;
  }
  return `${hours} heure(s) ${minutes} min`;
}

function isMenuCommand(normalized: string): boolean {
  return CMD_MENU.some(
    (c) => normalized === c || normalized.startsWith(c + ' '),
  );
}

function buildCancelledReply(penaltyAmount: number | null): string {
  const penaltyMsg = penaltyAmount
    ? `\nUne pénalité de ${penaltyAmount.toLocaleString('fr-FR')} FCFA a été appliquée.`
    : '';
  const title = penaltyAmount
    ? '*Candidature annulée avec pénalité*'
    : '*Candidature annulée*';
  return [
    title,
    '',
    'Votre candidature a été annulée.' + penaltyMsg,
    '',
    "L'employeur a été notifié.",
  ].join('\n');
}

async function executeCancellation(
  applicationId: string,
  profile: BotProfile,
  reason: string | undefined,
  isLatePenalty: boolean,
  ctx: CancelApplicationContext,
  state: BotState,
  jobOfferId?: string,
): Promise<FlowResult> {
  try {
    const result = await ctx.applicationService.cancel(
      applicationId,
      profile.id,
      reason,
    );
    if (jobOfferId) {
      void ctx.interestSignalService
        .record(profile.id, jobOfferId, 'cancel')
        .catch(() => undefined);
    }
    await ctx.notificationService
      .sendCancellationToEmployer(applicationId, reason ?? null, isLatePenalty)
      .catch((err: unknown) =>
        console.warn(
          `[cancel-application] sendCancellationToEmployer failed for ${applicationId}:`,
          err,
        ),
      );
    return {
      reply: [buildCancelledReply(result.penaltyAmount)],
      clearState: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Impossible d'annuler.";
    return {
      reply: [`❌ ${message}`],
      nextState: state,
    };
  }
}

function showInitialCancelPrompt(
  isLate: boolean,
  app: AppWithOffer,
  profile: BotProfile,
  state: BotState,
  timeRemainingStr: string,
  thresholdHours: number,
): FlowResult {
  const scheduledAt = app.job_offer.scheduled_at;
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
    thresholdHours,
  });
  return { reply: [text], nextState: state };
}

function handleLateCancellationInput(args: CancelStepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  const reason = trimmed || undefined;
  if (!reason) {
    return {
      reply: [
        "La raison est obligatoire pour une annulation tardive. Tapez votre raison d'annulation.",
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*Êtes-vous certain de vouloir annuler ?*',
        '',
        `*Pénalité*: ${LATE_CANCELLATION_PENALTY_FCFA.toLocaleString('fr-FR')} FCFA`,
        '1- Oui, annuler malgré la pénalité',
        '2- Non, maintenir ma candidature',
        '',
        '*Tapez le numéro correspondant.*',
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

async function handleCancelStep1(
  args: CancelStepArgs,
  app: AppWithOffer,
  isLate: boolean,
  timeRemainingStr: string,
): Promise<FlowResult> {
  const { state, applicationId, trimmed, normalized, profile, ctx } = args;

  if (!trimmed) {
    return showInitialCancelPrompt(
      isLate,
      app,
      profile,
      state,
      timeRemainingStr,
      args.ctx.cancellationThresholdHours,
    );
  }

  if (isLate) {
    return handleLateCancellationInput(args);
  }

  if (
    normalized === '1' ||
    normalized === 'confirmer' ||
    normalized === 'annuler'
  ) {
    return executeCancellation(
      applicationId,
      profile,
      undefined,
      false,
      ctx,
      state,
      args.jobOfferId,
    );
  }

  if (normalized === '2' || normalized === 'je serai présent') {
    return {
      reply: ['Annulation annulée. Votre candidature est maintenue.'],
      clearState: true,
    };
  }

  if (normalized === '3' || isMenuCommand(normalized)) {
    return { reply: [welcomePlatformMessage()], clearState: true };
  }

  return executeCancellation(
    applicationId,
    profile,
    trimmed,
    false,
    ctx,
    state,
    args.jobOfferId,
  );
}

async function handleCancelStep2(args: CancelStepArgs): Promise<FlowResult> {
  const {
    state,
    payload,
    applicationId,
    normalized,
    profile,
    ctx,
    jobOfferId,
  } = args;
  if (normalized === '1' || normalized === 'oui') {
    const reason = (payload.reason as string) ?? undefined;
    return executeCancellation(
      applicationId,
      profile,
      reason,
      true,
      ctx,
      state,
      jobOfferId,
    );
  }
  if (normalized === '2' || normalized === 'non') {
    return {
      reply: ['Annulation annulée. Votre candidature est maintenue.'],
      clearState: true,
    };
  }
  return {
    reply: ['Répondez par 1 (Oui, annuler) ou 2 (Non, maintenir).'],
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

  if (isMenuCommand(normalized)) {
    return { reply: [welcomePlatformMessage()], clearState: true };
  }

  if (!applicationId) {
    return {
      reply: ['❌ Candidature non trouvée.'],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: ['❌ Seuls les travailleurs peuvent annuler leurs candidatures.'],
      clearState: true,
    };
  }

  const app = await ctx.applicationService.findById(applicationId);
  if (app?.worker_id !== profile.id) {
    return {
      reply: ['❌ Candidature introuvable.'],
      clearState: true,
    };
  }

  // END counts on an ongoing engagement: there it means "the offer closed once
  // we were hired", not "the work is finished", and a hire that falls through
  // has to be reversible from WhatsApp too — this flow is how most workers
  // reach it. The service re-checks the same rule.
  const isReversibleHire =
    app.status === 'END' && closesOnFill(app.job_offer.employment_type);

  if (
    app.status !== 'PENDING' &&
    app.status !== 'ACCEPTED' &&
    app.status !== 'WAITING_PAYMENT' &&
    !isReversibleHire
  ) {
    return {
      reply: ['❌ Cette candidature ne peut plus être annulée.'],
      clearState: true,
    };
  }

  const now = new Date();
  const scheduledAt = app.job_offer.scheduled_at;
  // An offer with no closing date has no deadline: it can never be "already
  // passed", and leaving it is never late. Infinity keeps the arithmetic below
  // honest without a second branch through the whole flow.
  const msUntil =
    scheduledAt === null
      ? Number.POSITIVE_INFINITY
      : scheduledAt.getTime() - now.getTime();
  const hoursUntil = msUntil / (60 * 60 * 1000);

  if (hoursUntil < 0) {
    return {
      reply: ["*Cette offre est déjà passée. Impossible d'annuler.*"],
      clearState: true,
    };
  }

  const isLate = hoursUntil < ctx.cancellationThresholdHours;
  const timeRemainingStr =
    scheduledAt === null ? '—' : formatTimeRemaining(msUntil);

  const stepArgs: CancelStepArgs = {
    state,
    payload,
    applicationId,
    jobOfferId: app.job_offer_id,
    trimmed,
    normalized,
    profile,
    ctx,
  };

  if (state.step === 1) {
    return handleCancelStep1(stepArgs, app, isLate, timeRemainingStr);
  }
  if (state.step === 2) return handleCancelStep2(stepArgs);

  return { reply: ['❌ Erreur.'], clearState: true };
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
