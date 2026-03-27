import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import {
  formatOfferDetail,
  formatOfferDetailWithActions,
  formatOfferListCompact,
  formatPaymentFlow,
  type OfferListItem,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';

export type ListOffersContext = {
  jobOfferService: JobOfferService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;

type FlowParams = {
  state: BotState;
  payload: Record<string, unknown>;
  offerIds: string[];
  nextCursor: string | undefined;
  step: 'list' | 'detail';
  selectedOfferIndex: number | undefined;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: ListOffersContext;
  goToMenu: () => FlowResult;
};

function handleListStep(params: FlowParams): Promise<FlowResult> | FlowResult {
  const { state, offerIds, nextCursor, trimmed, goToMenu } = params;
  if (trimmed === '7') return goToMenu();
  if (trimmed === '6') return handleLoadMore(params);
  const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
  if (choice >= 1 && choice <= offerIds.length) {
    return handleListSelectOffer(choice - 1, params);
  }
  return {
    reply: [
      `*RÉPONDEZ PAR 1-5 POUR SÉLECTIONNER UNE OFFRE${nextCursor ? ', 6 (VOIR PLUS)' : ''} OU 7 (MENU).*`,
    ],
    nextState: state,
  };
}

async function handleLoadMore(params: FlowParams): Promise<FlowResult> {
  const { state, nextCursor, ctx, profile } = params;
  if (!nextCursor) {
    return {
      reply: [
        '*RÉPONDEZ PAR 1-5 POUR SÉLECTIONNER UNE OFFRE, 6 (VOIR PLUS) OU 7 (MENU).*',
      ],
      nextState: state,
    };
  }
  const { data, nextCursor: newCursor } = await ctx.jobOfferService.findActive(
    PAGE_SIZE,
    nextCursor,
    profile.id,
  );
  if (data.length === 0) {
    return {
      reply: ["*Plus d'offres. Tapez 7 ou 'Menu' pour revenir.*"],
      nextState: state,
    };
  }
  const newOfferIds = data.map((o) => o.id);
  const offers = data.map((o) => toOfferListItem(o));
  const message = formatOfferListCompact(offers, !!newCursor);
  return {
    reply: [message],
    nextState: {
      ...state,
      payload: {
        offerIds: newOfferIds,
        nextCursor: newCursor ?? undefined,
        step: 'list',
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleListSelectOffer(
  index: number,
  params: FlowParams,
): Promise<FlowResult> {
  const { state, payload, offerIds, ctx } = params;
  const offerId = offerIds[index];
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return {
      reply: ["*Cette offre n'existe plus. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const message = formatOfferDetailWithActions(toOfferListItem(offer));
  return {
    reply: [message],
    nextState: {
      ...state,
      payload: {
        ...payload,
        step: 'detail',
        selectedOfferIndex: index,
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handleDetailStep(
  params: FlowParams,
): Promise<FlowResult> | FlowResult {
  const { state, offerIds, trimmed, goToMenu } = params;
  const selectedOfferIndex = params.selectedOfferIndex;
  const offerId =
    selectedOfferIndex !== undefined && offerIds[selectedOfferIndex]
      ? offerIds[selectedOfferIndex]
      : null;
  if (!offerId) {
    return {
      reply: ["*INDEX INVALIDE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }
  if (trimmed === '4') return goToMenu();
  if (trimmed === '1') return handleDetailApply(offerId, params);
  if (trimmed === '2') return handleDetailViewDescription(offerId, params);
  if (trimmed === '3') return handleDetailBackToList(offerId, params);
  return {
    reply: [
      '*RÉPONDEZ PAR 1 (POSTULER), 2 (VOIR DESCRIPTION COMPLÈTE), 3 (RETOUR LISTE) OU 4 (MENU).*',
    ],
    nextState: state,
  };
}

function formatOfferDate(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function handleDetailApply(
  offerId: string,
  params: FlowParams,
): Promise<FlowResult> {
  const { ctx } = params;
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return {
      reply: ["*Cette offre n'existe plus. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const flowLabel = formatPaymentFlow(offer.payment_flow);
  const penaltyStr = await ctx.systemConfigService.getRaw(
    'fees.late_cancellation_penalty_fcfa',
    '5000',
  );
  const penalty = Number(penaltyStr) || 5000;
  const text = [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${offer.title}`,
    `*Date*: ${formatOfferDate(offer.scheduled_at)}`,
    `*Montant*: ${offer.amount.toLocaleString('fr-FR')} FCFA ${flowLabel}`,
    `*Adresse*: ${offer.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "Vos informations seront partagées avec l'employeur",
    'Vous vous engagez à être présent et ponctuel',
    `*Annulation < 4h avant = pénalité de ${penalty.toLocaleString('fr-FR')} FCFA*`,
    'Impact sur votre score de fiabilité',
    '',
    '*Confirmez-vous votre candidature ?*',
    '1️⃣ Oui, je postule',
    '2️⃣ Non, retour',
    '',
    '*Tapez le numéro correspondant.*',
    '',
  ].join('\n');
  const applyState = getApplyJobInitialState(offerId);
  return { reply: [text], nextState: applyState };
}

async function handleDetailViewDescription(
  offerId: string,
  params: FlowParams,
): Promise<FlowResult> {
  const { state, ctx } = params;
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return {
      reply: ["*Offre introuvable. Tapez 'Menu'.*"],
      clearState: true,
    };
  }
  const text = formatOfferDetail(toOfferListItem(offer));
  return { reply: [text], nextState: state };
}

async function handleDetailBackToList(
  _offerId: string,
  params: FlowParams,
): Promise<FlowResult> {
  const { state, offerIds, nextCursor, ctx } = params;
  const offers = await Promise.all(
    offerIds.map((id) => ctx.jobOfferService.findById(id)),
  );
  const validOffers = offers.filter(
    (o): o is NonNullable<typeof o> => o != null,
  );
  const listItems = validOffers.map((o) => toOfferListItem(o));
  const message = formatOfferListCompact(listItems, !!nextCursor);
  return {
    reply: [message],
    nextState: {
      ...state,
      payload: {
        offerIds,
        nextCursor,
        step: 'list',
        selectedOfferIndex: undefined,
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

function toOfferListItem(offer: {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount?: number;
  status: string;
  employer?: { reliability_score?: number | null } | null;
}): OfferListItem {
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description,
    scheduled_at: offer.scheduled_at,
    amount: offer.amount,
    payment_flow: offer.payment_flow,
    address: offer.address,
    note: offer.note,
    quantity: offer.quantity,
    acceptedCount: offer.acceptedCount ?? 0,
    status: offer.status,
    employerScore: offer.employer?.reliability_score ?? null,
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
  const nextCursor = payload.nextCursor as string | undefined;
  const step = (payload.step as 'list' | 'detail') ?? 'list';
  const selectedOfferIndex = payload.selectedOfferIndex as number | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (offerIds.length === 0) {
    return {
      reply: ["*Aucune offre. Tapez 'Menu' pour revenir.*"],
      clearState: true,
    };
  }

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  const flowParams: FlowParams = {
    state,
    payload,
    offerIds,
    nextCursor,
    step,
    selectedOfferIndex,
    trimmed,
    normalized,
    profile,
    ctx,
    goToMenu,
  };

  if (step === 'list') {
    return await handleListStep(flowParams);
  }
  if (step === 'detail') {
    return await handleDetailStep(flowParams);
  }

  return {
    reply: ["*ERREUR. TAPEZ 'MENU' POUR REVENIR.*"],
    clearState: true,
  };
}

export function getListOffersInitialState(
  offerIds: string[],
  nextCursor?: string | null,
): BotState {
  return {
    flowId: FLOW_IDS.LIST_OFFERS,
    step: 0,
    payload: {
      offerIds,
      nextCursor: nextCursor ?? undefined,
      step: 'list',
    },
    updatedAt: new Date().toISOString(),
  };
}
