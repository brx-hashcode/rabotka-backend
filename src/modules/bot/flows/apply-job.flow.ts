import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatApplyConfirmation,
  formatApplicationSentSuccess,
} from '../messages/application.messages';
import {
  formatAmount,
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
    let created: { id: string };
    try {
      created = await ctx.applicationService.create(jobOfferId, profile.id);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Impossible de postuler.';
      return {
        reply: [`❌ ${message} Tapez *Menu* pour revenir.`],
        clearState: true,
      };
    }
    // Notification is best-effort — never let it mask a successful application
    await ctx.notificationService.sendNewApplicationToEmployer(created.id);
    return {
      reply: [formatApplicationSentSuccess(offer.title)],
      clearState: true,
    };
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
        "*Retour sans envoi de candidature.*\n\nVous n'avez pas postulé à cette offre.\n\nTapez *1* (Trouver une mission) pour voir les offres, ou *Menu* pour le menu principal.",
      ],
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
      reply: ['❌ Offre non trouvée. Tapez *Menu* pour revenir.'],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: [
        '❌ Seuls les travailleurs peuvent postuler aux offres. Tapez *Menu*.',
      ],
      clearState: true,
    };
  }

  const unpaid = await ctx.applicationService.getUnpaidPenalties(profile.id);
  if (unpaid.count > 0) {
    return {
      reply: [formatPenaltyBlocked(unpaid.total, '', '')],
      clearState: true,
    };
  }

  const offer = await ctx.jobOfferService.findById(jobOfferId);
  if (!offer) {
    return {
      reply: ["❌ Cette offre n'existe plus. Tapez *Menu*."],
      clearState: true,
    };
  }

  if (state.step === 0) {
    if (normalized === '1' || normalized === 'postuler') {
      // Advance to full engagement/confirmation screen
      const step1State: BotState = {
        ...state,
        step: 1,
        updatedAt: new Date().toISOString(),
      };
      return handleApplyStep1(
        {
          state: step1State,
          jobOfferId,
          trimmed: '',
          normalized: '',
          profile,
          ctx,
        },
        offer,
      );
    }
    if (
      normalized === '2' ||
      normalized === 'non' ||
      normalized === 'ignorer'
    ) {
      return { reply: [menuMessage(profile.profile_type)], clearState: true };
    }
    return {
      reply: [
        [
          `*${offer.title}*`,
          `*Date*: ${offer.scheduled_at.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
          `*Montant*: ${formatAmount(offer.amount, offer.payment_flow)}`,
          `*Adresse*: ${offer.address}`,
          '',
          '1- Postuler',
          '2- Menu',
        ].join('\n'),
      ],
      nextState: state,
    };
  }

  if (state.step === 1) {
    return handleApplyStep1(
      { state, jobOfferId, trimmed, normalized, profile, ctx },
      offer,
    );
  }

  return {
    reply: ['❌ Erreur. Tapez *Menu* pour revenir.'],
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
      ...(returnToListOffers === undefined ? {} : { returnToListOffers }),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** State for push notifications — worker lands on teaser step 0 first. */
export function getApplyJobNotificationState(jobOfferId: string): BotState {
  return {
    flowId: FLOW_IDS.APPLY_JOB,
    step: 0,
    payload: { jobOfferId },
    updatedAt: new Date().toISOString(),
  };
}
