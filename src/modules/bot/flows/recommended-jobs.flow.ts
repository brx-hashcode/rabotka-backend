import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import {
  formatOfferDetail,
  formatOfferDetailWithActions,
  formatOfferListCompact,
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

export async function runRecommendedJobsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedJobsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const offerIds = (payload.offerIds as string[]) ?? [];
  const step = (payload.step as 'list' | 'detail') ?? 'list';
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))) {
    return goToMenu();
  }

  if (offerIds.length === 0) {
    return {
      reply: ["*Aucune offre recommandée pour le moment. Tapez 'Menu' pour revenir.*"],
      clearState: true,
    };
  }

  if (step === 'list') {
    if (trimmed === '7') return goToMenu();
    const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
    if (choice >= 1 && choice <= Math.min(offerIds.length, 5)) {
      const offerId = offerIds[choice - 1];
      const offer = await ctx.jobOfferService.findById(offerId!);
      if (!offer) {
        return { reply: ['Offre introuvable.'], nextState: state };
      }
      const item = toOfferListItem({ ...offer, acceptedCount: 0 });
      const detailMsg = formatOfferDetailWithActions(item);
      return {
        reply: [detailMsg],
        nextState: {
          ...state,
          payload: { ...payload, step: 'detail', selectedOfferId: offerId },
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return {
      reply: [`*Tapez 1-${Math.min(offerIds.length, 5)} pour voir le détail ou 7 pour le menu.*`],
      nextState: state,
    };
  }

  if (step === 'detail') {
    const selectedOfferId = payload.selectedOfferId as string;
    if (normalized === '1' || normalized === 'postuler') {
      const applyState = getApplyJobInitialState(selectedOfferId);
      return { reply: [], nextState: applyState };
    }
    if (normalized === '2' || normalized === 'retour') {
      // Back to list
      return {
        reply: [
          '*Offres recommandées — tapez le numéro pour voir le détail ou 7 pour le menu.*',
        ],
        nextState: {
          ...state,
          payload: { ...payload, step: 'list' },
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return goToMenu();
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
