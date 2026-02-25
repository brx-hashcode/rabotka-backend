import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import {
  formatOfferDetail,
  formatOfferList,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';

export type ListOffersContext = {
  jobOfferService: JobOfferService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type ListOffersStepArgs = {
  state: BotState;
  payload: Record<string, unknown>;
  offerIds: string[];
  currentIndex: number;
  offerId: string;
  profile: BotProfile;
  ctx: ListOffersContext;
};

function paymentFlowLabel(flow: string): string {
  if (flow === 'HOURLY') return 'par heure';
  if (flow === 'DAILY') return 'par jour';
  return 'par mois';
}

async function handleListOfferPostuler(
  args: ListOffersStepArgs,
): Promise<FlowResult> {
  const { offerId, ctx } = args;
  const applyState = getApplyJobInitialState(offerId);
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return {
      reply: ["*Cette offre n'existe plus. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const formatDate = (d: Date) =>
    d.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const flowLabel = paymentFlowLabel(offer.payment_flow);
  const text = [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${offer.title}`,
    `*Date*: ${formatDate(offer.scheduled_at)}`,
    `*Montant*: ${offer.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
    `*Adresse*: ${offer.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "✓ Vos informations seront partagées avec l'employeur",
    '*Vous vous engagez à être présent et ponctuel*',
    '*Annulation < 4h avant = pénalité de 5,000 FCFA*',
    '',
    '*Confirmez-vous votre candidature ?*',
    '1️⃣ Oui, je postule',
    '2️⃣ Non, retour',
    '',
    'Tapez 1 ou 2.',
  ].join('\n');
  return { reply: [text], nextState: applyState };
}

async function handleListOfferDetails(
  args: ListOffersStepArgs,
): Promise<FlowResult> {
  const { state, offerId, ctx } = args;
  const detail = await ctx.jobOfferService.findById(offerId);
  if (!detail) {
    return {
      reply: ["*Offre introuvable. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const text = formatOfferDetail({
    id: detail.id,
    title: detail.title,
    description: detail.description,
    scheduled_at: detail.scheduled_at,
    amount: detail.amount,
    payment_flow: detail.payment_flow,
    address: detail.address,
    note: detail.note,
    status: detail.status,
  });
  return { reply: [text], nextState: state };
}

async function handleListOfferNext(
  args: ListOffersStepArgs,
): Promise<FlowResult> {
  const { state, payload, offerIds, currentIndex, ctx } = args;
  const nextIndex = currentIndex + 1;
  if (nextIndex >= offerIds.length) {
    return {
      reply: [
        "*Fin de la liste. Tapez '1' pour voir les offres depuis le début ou 'Menu' pour revenir.*",
      ],
      nextState: state,
    };
  }
  const nextOfferId = offerIds[nextIndex];
  const nextOffer = await ctx.jobOfferService.findById(nextOfferId);
  if (!nextOffer) {
    return {
      reply: ["*Offre introuvable. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const listText = formatOfferList(
    [
      {
        id: nextOffer.id,
        title: nextOffer.title,
        description: nextOffer.description,
        scheduled_at: nextOffer.scheduled_at,
        amount: nextOffer.amount,
        payment_flow: nextOffer.payment_flow,
        address: nextOffer.address,
        note: nextOffer.note,
        status: nextOffer.status,
      },
    ],
    1,
    { hasNext: false },
  );
  return {
    reply: [listText],
    nextState: {
      ...state,
      step: 0,
      payload: { ...payload, currentIndex: nextIndex },
      updatedAt: new Date().toISOString(),
    },
  };
}

export async function runListOffersFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ListOffersContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const offerIds = (payload.offerIds as string[]) ?? [];
  const currentIndex = (payload.currentIndex as number) ?? 0;
  const trimmed = input.trim();

  if (offerIds.length === 0) {
    return {
      reply: ["*Aucune offre. Tapez 'Menu' pour revenir.*"],
      clearState: true,
    };
  }

  const offerId = offerIds[currentIndex];
  if (!offerId) {
    return {
      reply: ["*INDEX INVALIDE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const stepArgs: ListOffersStepArgs = {
    state,
    payload,
    offerIds,
    currentIndex,
    offerId,
    profile,
    ctx,
  };

  if (trimmed === '1') return handleListOfferPostuler(stepArgs);
  if (trimmed === '2') return handleListOfferDetails(stepArgs);
  if (trimmed === '3') return handleListOfferNext(stepArgs);
  if (trimmed === '4') {
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }

  return {
    reply: [
      '*RÉPONDEZ PAR 1 (POSTULER), 2 (VOIR DÉTAILS), 3 (SUIVANT) OU 4 (MENU).*',
    ],
    nextState: state,
  };
}

export function getListOffersInitialState(
  offerIds: string[],
  nextCursor?: string | null,
): BotState {
  return {
    flowId: FLOW_IDS.LIST_OFFERS,
    step: 0,
    payload: { offerIds, currentIndex: 0, nextCursor: nextCursor ?? undefined },
    updatedAt: new Date().toISOString(),
  };
}
