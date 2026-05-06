import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';
import {
  formatOfferDetailWithActions,
  formatRecommendedList,
  type OfferListItem,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';

export type RecommendedJobsContext = {
  jobOfferService: JobOfferService;
  interestSignalService: InterestSignalService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 3;
type RecommendedStep = 'list' | 'detail';

function toOfferListItem(o: {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: string | null;
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

function buildPagedListReply(
  offers: OfferListItem[],
  page: number,
): { reply: string[]; page: number } {
  const totalPages = Math.ceil(offers.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageOffers = offers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  return {
    reply: [formatRecommendedList(pageOffers, safePage, totalPages)],
    page: safePage,
  };
}

async function handleRecommendedJobsListStep(
  state: BotState,
  payload: Record<string, unknown>,
  trimmedInput: string,
  offers: OfferListItem[],
  profile: BotProfile,
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  const normalized = trimmedInput.toLowerCase();
  if (normalized === 'm' || normalized === 'menu') return goToMenu();

  const currentPage = typeof payload.page === 'number' ? payload.page : 0;
  const totalPages = Math.ceil(offers.length / PAGE_SIZE);

  // Pagination navigation
  if (normalized === 's' && currentPage < totalPages - 1) {
    const { reply, page } = buildPagedListReply(offers, currentPage + 1);
    return {
      reply,
      nextState: buildListState(state, { ...payload, page }),
    };
  }
  if (normalized === 'p' && currentPage > 0) {
    const { reply, page } = buildPagedListReply(offers, currentPage - 1);
    return {
      reply,
      nextState: buildListState(state, { ...payload, page }),
    };
  }

  const pageOffers = offers.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const maxChoice = pageOffers.length;
  const choice = /^\d+$/.test(trimmedInput) ? Number.parseInt(trimmedInput, 10) : 0;

  if (choice < 1 || choice > maxChoice) {
    const { reply } = buildPagedListReply(offers, currentPage);
    return { reply, nextState: state };
  }

  const item = pageOffers[choice - 1];

  // Fetch fresh detail for the full description
  const fresh = await ctx.jobOfferService.findById(item.id);
  if (!fresh) return { reply: ['Offre introuvable.'], nextState: state };

  const freshItem = toOfferListItem({
    ...fresh,
    acceptedCount: fresh.acceptedCount ?? 0,
  });

  void ctx.interestSignalService
    .record(profile.id, item.id, 'view')
    .catch(() => undefined);

  return {
    reply: [formatOfferDetailWithActions(freshItem)],
    nextState: buildDetailState(state, payload, item.id),
  };
}

async function handleRecommendedJobsDetailStep(
  state: BotState,
  payload: Record<string, unknown>,
  normalizedInput: string,
  profile: BotProfile,
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  const selectedOfferId = payload.selectedOfferId as string;

  // 1 — Postuler
  if (normalizedInput === '1' || normalizedInput === 'postuler') {
    void ctx.interestSignalService
      .record(profile.id, selectedOfferId, 'apply')
      .catch(() => undefined);
    return { reply: [], nextState: getApplyJobInitialState(selectedOfferId) };
  }

  // 2 — Voir description complète
  if (normalizedInput === '2') {
    const offer = await ctx.jobOfferService.findById(selectedOfferId);
    if (!offer) return { reply: ['Offre introuvable.'], nextState: state };
    return {
      reply: [
        [
          `*${offer.title}*`,
          '',
          offer.description,
          '',
          '1- Postuler à cette offre',
          '3- Retour à la liste',
          '4- Menu principal',
          '',
          'Tapez le numéro correspondant.',
        ].join('\n'),
      ],
      nextState: state,
    };
  }

  // 3 — Retour à la liste
  if (normalizedInput === '3' || normalizedInput === 'retour') {
    void ctx.interestSignalService
      .record(profile.id, selectedOfferId, 'skip')
      .catch(() => undefined);
    const offers = (payload.offers as OfferListItem[] | undefined) ?? [];
    const currentPage = typeof payload.page === 'number' ? payload.page : 0;
    const { reply } = buildPagedListReply(offers, currentPage);
    return {
      reply,
      nextState: buildListState(state, payload),
    };
  }

  // 4 / Menu
  return goToMenu();
}

export async function runRecommendedJobsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedJobsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const offers = (payload.offers as OfferListItem[] | undefined) ?? [];
  const step = (payload.step as RecommendedStep) ?? 'list';
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (isMenuCommand(normalized)) return goToMenu();

  if (offers.length === 0) {
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
      offers,
      profile,
      ctx,
      goToMenu,
    );
  }

  if (step === 'detail') {
    return await handleRecommendedJobsDetailStep(
      state,
      payload,
      normalized,
      profile,
      ctx,
      goToMenu,
    );
  }

  return {
    reply: ["*ERREUR. TAPEZ 'MENU' POUR REVENIR.*"],
    clearState: true,
  };
}

export function getRecommendedJobsInitialState(
  offerIds: string[],
  offers: OfferListItem[],
): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_JOBS,
    step: 0,
    payload: { offerIds, offers, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}
