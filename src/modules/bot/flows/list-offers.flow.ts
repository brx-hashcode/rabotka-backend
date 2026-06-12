import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import {
  formatAmount,
  formatOfferDetail,
  formatOfferDetailWithActions,
  formatOfferListCompact,
  formatNoOffersAvailable,
  jobOfferToOfferListItem,
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
  const { state, offerIds, nextCursor, trimmed, normalized, goToMenu } = params;
  if (normalized === 'm') return goToMenu();
  if (normalized === 's') return handleLoadMore(params);
  const choice = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
  if (choice >= 1 && choice <= offerIds.length) {
    return handleListSelectOffer(choice - 1, params);
  }
  const nextPageIdx = offerIds.length + 1;
  const menuIdx = offerIds.length + 2;
  if (choice === nextPageIdx && nextCursor) return handleLoadMore(params);
  if (choice === menuIdx) return goToMenu();
  return {
    reply: [
      `Tapez un numéro (1-${offerIds.length}) pour sélectionner une offre${nextCursor ? `, ${nextPageIdx} (voir plus)` : ''}, ${menuIdx} (menu).`,
    ],
    nextState: state,
  };
}

async function handleLoadMore(params: FlowParams): Promise<FlowResult> {
  const { state, nextCursor, ctx, profile } = params;
  if (!nextCursor) {
    return {
      reply: [
        'Répondez par 1-5 pour sélectionner une offre, 6 (voir plus) ou 7 (menu).',
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
  const offers = data.map((o) => jobOfferToOfferListItem(o));
  const nextPage = ((params.payload.page as number | undefined) ?? 0) + 1;
  const message = formatOfferListCompact(offers, !!newCursor, nextPage);
  return {
    reply: [message],
    nextState: {
      ...state,
      payload: {
        offerIds: newOfferIds,
        nextCursor: newCursor ?? undefined,
        step: 'list',
        page: nextPage,
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
      reply: ["*Cette offre n'existe plus. Tapez *Menu*.*"],
      clearState: true,
    };
  }
  const message = formatOfferDetailWithActions(jobOfferToOfferListItem(offer));
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
      reply: ["❌ Index invalide. Tapez *Menu*."],
      clearState: true,
    };
  }
  if (trimmed === '4') return goToMenu();
  if (trimmed === '1') return handleDetailApply(offerId, params);
  if (trimmed === '2') return handleDetailViewDescription(offerId, params);
  if (trimmed === '3') return handleDetailBackToList(offerId, params);
  return {
    reply: [
      'Répondez par 1 (Postuler), 2 (Voir description complète), 3 (Retour liste) ou 4 (Menu).',
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
  const { ctx, profile } = params;
  if (profile.profile_type !== 'WORKER') {
    return {
      reply: ["❌ Seuls les travailleurs peuvent postuler à une offre."],
      nextState: params.state,
    };
  }
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return {
      reply: ["*Cette offre n'existe plus. Tapez *Menu*.*"],
      clearState: true,
    };
  }
  const fees = await ctx.systemConfigService.getFees();
  const penalty = fees.lateCancellationPenaltyFcfa;
  const cancellationThresholdHours = fees.cancellationThresholdHours;
  const text = [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${offer.title}`,
    `*Date*: ${formatOfferDate(offer.scheduled_at)}`,
    `*Montant*: ${formatAmount(offer.amount, offer.payment_flow)}`,
    `*Adresse*: ${offer.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "Vos informations seront partagées avec l'employeur",
    'Vous vous engagez à être présent et ponctuel',
    `*Annulation < ${cancellationThresholdHours}h avant = pénalité de ${penalty.toLocaleString('fr-FR')} FCFA*`,
    'Impact sur votre score de fiabilité',
    '',
    '*Confirmez-vous votre candidature ?*',
    '1- Oui, je postule',
    '2- Non, retour',
    '',
    '*Tapez le numéro correspondant.*',
    '',
  ].join('\n');
  const pl = params.state.payload || {};
  const offerIds = (pl.offerIds as string[]) ?? [];
  const nextCursor = pl.nextCursor as string | undefined;
  const selectedOfferIndex =
    pl.selectedOfferIndex === undefined
      ? Math.max(0, offerIds.indexOf(offerId))
      : (pl.selectedOfferIndex as number);

  const applyState = getApplyJobInitialState(offerId, {
    offerIds,
    nextCursor,
    selectedOfferIndex,
  });
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
      reply: ["*Offre introuvable. Tapez *Menu*.*"],
      clearState: true,
    };
  }
  const text = formatOfferDetail(jobOfferToOfferListItem(offer));
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
  const withOpenSlots = validOffers.filter((o) => {
    const accepted = o.acceptedCount ?? 0;
    return accepted < o.quantity;
  });
  if (withOpenSlots.length === 0) {
    return {
      reply: [formatNoOffersAvailable()],
      clearState: true,
    };
  }
  const listItems = withOpenSlots.map((o) => jobOfferToOfferListItem(o));
  const currentPage = (params.payload.page as number | undefined) ?? 0;
  const message = formatOfferListCompact(listItems, !!nextCursor, currentPage);
  return {
    reply: [message],
    nextState: {
      ...state,
      payload: {
        offerIds: withOpenSlots.map((o) => o.id),
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
  amount: number | null;
  payment_flow: string | null;
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
      reply: ["*Aucune offre. Tapez *Menu* pour revenir.*"],
      clearState: true,
    };
  }

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    normalized === 'm' ||
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
    reply: ["❌ Erreur. Tapez *Menu* pour revenir."],
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
