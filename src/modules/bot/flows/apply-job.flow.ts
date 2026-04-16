import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatApplyConfirmation,
  formatApplicationSentSuccess,
} from '../messages/application.messages';
import {
  formatOfferDetailWithActions,
  jobOfferToOfferListItem,
} from '../messages/offers.messages';
import { formatPenaltyBlocked } from '../messages/penalty.messages';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { SystemConfigService } from '../../system-config/system-config.service';

export type ApplyJobContext = {
  applicationService: ApplicationService;
  jobOfferService: JobOfferService;
  notificationService: BotNotificationService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

/** When set, choosing « Non, retour » on apply confirmation restores list-offers detail. */
export type ApplyJobReturnToListOffersPayload = {
  offerIds: string[];
  nextCursor?: string;
  selectedOfferIndex: number;
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
  amount: number | null;
  payment_flow: string | null;
  address: string;
};

async function handleApplyStep1(
  args: ApplyStepArgs,
  offer: JobOfferForApply,
): Promise<FlowResult> {
  const { state, jobOfferId, trimmed, normalized, profile, ctx } = args;
  if (!trimmed) {
    const workerName = `${profile.first_name} ${profile.last_name}`;
    const fees = await ctx.systemConfigService.getFees();
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
      lateCancellationPenalty: fees.lateCancellationPenaltyFcfa,
      lateCancellationThresholdHours: fees.cancellationThresholdHours,
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
        err instanceof Error ? err.message : '*IMPOSSIBLE DE POSTULER.*';
      return {
        reply: [`❌ ${message} *TAPEZ 'MENU' POUR REVENIR.*`],
        clearState: true,
      };
    }
  }
  if (normalized === '2' || normalized === 'non') {
    const ret = state.payload?.returnToListOffers as
      | ApplyJobReturnToListOffersPayload
      | undefined;

    if (ret?.offerIds?.length) {
      const fullOffer = await ctx.jobOfferService.findById(jobOfferId);
      if (!fullOffer) {
        return {
          reply: [
            "*Cette offre n'est plus disponible.* Tapez *Menu* pour revenir.",
          ],
          clearState: true,
        };
      }
      const detailMsg = formatOfferDetailWithActions(
        jobOfferToOfferListItem(fullOffer),
      );
      return {
        reply: [detailMsg],
        nextState: {
          flowId: FLOW_IDS.LIST_OFFERS,
          step: 0,
          payload: {
            offerIds: ret.offerIds,
            nextCursor: ret.nextCursor,
            step: 'detail',
            selectedOfferIndex: ret.selectedOfferIndex,
          },
          updatedAt: new Date().toISOString(),
        },
      };
    }

    return {
      reply: [
        "*Retour sans envoi de candidature.*\n\nVous n'avez pas postulé à cette offre. Tapez *Menu* pour le menu principal.",
      ],
      clearState: true,
    };
  }
  return {
    reply: ['*RÉPONDEZ PAR 1 (OUI, JE POSTULE) OU 2 (NON, RETOUR).*'],
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

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }

  if (!jobOfferId) {
    return {
      reply: ["*ERREUR: OFFRE NON TROUVÉE. TAPEZ 'MENU' POUR REVENIR.*"],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: ["*SEULS LES WORKERS PEUVENT POSTULER AUX OFFRES. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const unpaid = await ctx.applicationService.getUnpaidPenalties(profile.id);
  if (unpaid.count > 0) {
    const contact = await ctx.systemConfigService.getContactInfo();
    return {
      reply: [
        formatPenaltyBlocked(
          unpaid.total,
          contact.orangeMoneyNumber,
          contact.airtelMoneyNumber,
        ),
      ],
      clearState: true,
    };
  }

  const offer = await ctx.jobOfferService.findById(jobOfferId);
  if (!offer) {
    return {
      reply: ["*CETTE OFFRE N'EXISTE PLUS. TAPEZ 'MENU'.*"],
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
    reply: ["*ERREUR. TAPEZ 'MENU' POUR REVENIR.*"],
    clearState: true,
  };
}

export function getApplyJobInitialState(
  jobOfferId: string,
  returnToListOffers?: ApplyJobReturnToListOffersPayload,
): BotState {
  return {
    flowId: FLOW_IDS.APPLY_JOB,
    step: 1,
    payload: {
      jobOfferId,
      ...(returnToListOffers ? { returnToListOffers } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}
