import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import {
  formatOfferDetailWithActions,
  type OfferListItem,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';

export type RecommendedJobsContext = {
  jobOfferService: JobOfferService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;
type RecommendedStep = 'list' | 'detail';

function toOfferListItem(o: {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount: number;
  status: string;
}): OfferListItem {
  return {
    id: o.id,
    title: o.title,
    description: o.description,
    scheduled_at: o.scheduled_at,
    amount: o.amount,
    payment_flow: o.payment_flow,
    address: o.address,
    note: o.note,
    quantity: o.quantity,
    acceptedCount: o.acceptedCount,
    status: o.status,
    employerScore: null,
  };
}

function isMenuCommand(normalizedInput: string): boolean {
  return CMD_MENU.some(
    (command) =>
      normalizedInput === command || normalizedInput.startsWith(command + ' '),
  );
}

function buildRecommendedListPrompt(offerIdsCount: number): string {
  return `*Tapez 1-${Math.min(offerIdsCount, PAGE_SIZE)} pour voir le détail ou 7 pour le menu.*`;
}

function buildListState(
  state: BotState,
  payload: Record<string, unknown>,
): BotState {
  return {
    ...state,
    payload: { ...payload, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}

function buildDetailState(
  state: BotState,
  payload: Record<string, unknown>,
  selectedOfferId: string,
): BotState {
  return {
    ...state,
    payload: { ...payload, step: 'detail', selectedOfferId },
    updatedAt: new Date().toISOString(),
  };
}

async function handleRecommendedJobsListStep(
  state: BotState,
  payload: Record<string, unknown>,
  trimmedInput: string,
  offerIds: string[],
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  if (trimmedInput === '7') return goToMenu();

  const choice = /^[1-5]$/.test(trimmedInput)
    ? Number.parseInt(trimmedInput, 10)
    : 0;
  const maxChoice = Math.min(offerIds.length, PAGE_SIZE);

  if (choice < 1 || choice > maxChoice) {
    return {
      reply: [buildRecommendedListPrompt(offerIds.length)],
      nextState: state,
    };
  }

  const offerId = offerIds[choice - 1];
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) {
    return { reply: ['Offre introuvable.'], nextState: state };
  }

  const item = toOfferListItem({ ...offer, acceptedCount: 0 });
  const detailMsg = formatOfferDetailWithActions(item);
  return {
    reply: [detailMsg],
    nextState: buildDetailState(state, payload, offerId),
  };
}

function handleRecommendedJobsDetailStep(
  state: BotState,
  payload: Record<string, unknown>,
  normalizedInput: string,
  goToMenu: () => FlowResult,
): FlowResult {
  const selectedOfferId = payload.selectedOfferId as string;

  if (normalizedInput === '1' || normalizedInput === 'postuler') {
    return { reply: [], nextState: getApplyJobInitialState(selectedOfferId) };
  }

  if (normalizedInput === '2' || normalizedInput === 'retour') {
    return {
      reply: [
        '*Offres recommandées — tapez le numéro pour voir le détail ou 7 pour le menu.*',
      ],
      nextState: buildListState(state, payload),
    };
  }

  return goToMenu();
}

export async function runRecommendedJobsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedJobsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const offerIds = (payload.offerIds as string[]) ?? [];
  const step = (payload.step as RecommendedStep) ?? 'list';
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (isMenuCommand(normalized)) {
    return goToMenu();
  }

  if (offerIds.length === 0) {
    return {
      reply: [
        "*Aucune offre recommandée pour le moment. Tapez 'Menu' pour revenir.*",
      ],
      clearState: true,
    };
  }

  if (step === 'list') {
    return handleRecommendedJobsListStep(
      state,
      payload,
      trimmed,
      offerIds,
      ctx,
      goToMenu,
    );
  }

  if (step === 'detail') {
    return handleRecommendedJobsDetailStep(
      state,
      payload,
      normalized,
      goToMenu,
    );
  }

  return {
    reply: ["*ERREUR. TAPEZ 'MENU' POUR REVENIR.*"],
    clearState: true,
  };
}

export function getRecommendedJobsInitialState(offerIds: string[]): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_JOBS,
    step: 0,
    payload: { offerIds, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}
