import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import {
  formatApplyConfirmation,
  formatApplicationSentSuccess,
} from '../messages/application.messages';
import type { ApplicationService } from '../../application/application.service';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type ApplyJobContext = {
  applicationService: ApplicationService;
  jobOfferService: JobOfferService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type ApplyStepArgs = {
  state: BotState;
  jobOfferId: string;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: ApplyJobContext;
};

type JobOfferForApply = {
  title: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
};

async function handleApplyStep1(
  args: ApplyStepArgs,
  offer: JobOfferForApply,
): Promise<FlowResult> {
  const { state, jobOfferId, trimmed, normalized, profile, ctx } = args;
  if (!trimmed) {
    const workerName = `${profile.first_name} ${profile.last_name}`;
    const text = formatApplyConfirmation({
      title: offer.title,
      scheduled_at: offer.scheduled_at,
      amount: offer.amount,
      payment_flow: offer.payment_flow,
      address: offer.address,
      workerName,
      workerPhone: profile.phone,
      workerEmail: profile.email,
      reliabilityScore: profile.reliability_score,
    });
    return { reply: [text], nextState: state };
  }
  if (
    normalized === '1' ||
    normalized === 'oui' ||
    normalized === 'oui, je postule'
  ) {
    try {
      const created = await ctx.applicationService.create(
        jobOfferId,
        profile.id,
      );
      await ctx.notificationService.sendNewApplicationToEmployer(created.id);
      return {
        reply: [formatApplicationSentSuccess(offer.title)],
        clearState: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Impossible de postuler.';
      return {
        reply: [`❌ ${message} Tapez 'Menu' pour revenir.`],
        nextState: state,
      };
    }
  }
  if (normalized === '2' || normalized === 'non') {
    return {
      reply: ["Candidature annulée. Tapez 'Menu' pour revenir."],
      clearState: true,
    };
  }
  return {
    reply: ['Répondez par 1 (Oui, je postule) ou 2 (Non, retour).'],
    nextState: state,
  };
}

export async function runApplyJobFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ApplyJobContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const jobOfferId = payload.jobOfferId as string | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (!jobOfferId) {
    return {
      reply: ["Erreur: offre non trouvée. Tapez 'Menu' pour revenir."],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: ["Seuls les workers peuvent postuler aux offres. Tapez 'Menu'."],
      clearState: true,
    };
  }

  const offer = await ctx.jobOfferService.findById(jobOfferId);
  if (!offer) {
    return {
      reply: ["Cette offre n'existe plus. Tapez 'Menu'."],
      clearState: true,
    };
  }

  if (state.step === 1) {
    return handleApplyStep1(
      { state, jobOfferId, trimmed, normalized, profile, ctx },
      offer,
    );
  }

  return {
    reply: ["Erreur. Tapez 'Menu' pour revenir."],
    clearState: true,
  };
}

export function getApplyJobInitialState(jobOfferId: string): BotState {
  return {
    flowId: FLOW_IDS.APPLY_JOB,
    step: 1,
    payload: { jobOfferId },
    updatedAt: new Date().toISOString(),
  };
}
