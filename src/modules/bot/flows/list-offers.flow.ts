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

export type ListOffersContext = {
  jobOfferService: JobOfferService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;

function toOfferListItem(offer: {
  id: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number;
  payment_flow: string;
  address: string;
  note: string | null;
  status: string;
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
    status: offer.status,
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

  if (CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))) {
    return goToMenu();
  }

  if (step === 'list') {
    if (trimmed === '7') return goToMenu();

    if (trimmed === '6') {
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

    const choice = trimmed.match(/^[1-5]$/) ? parseInt(trimmed, 10) : 0;
    if (choice >= 1 && choice <= offerIds.length) {
      const index = choice - 1;
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

    return {
      reply: [
        `*RÉPONDEZ PAR 1-5 POUR SÉLECTIONNER UNE OFFRE${nextCursor ? ', 6 (VOIR PLUS)' : ''} OU 7 (MENU).*`,
      ],
      nextState: state,
    };
  }

  if (step === 'detail') {
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

    if (trimmed === '1') {
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
      const flowLabel =
        offer.payment_flow === 'HOURLY'
          ? 'par heure'
          : offer.payment_flow === 'DAILY'
            ? 'par jour'
            : 'par mois';
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

    if (trimmed === '2') {
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

    if (trimmed === '3') {
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

    return {
      reply: [
        '*RÉPONDEZ PAR 1 (POSTULER), 2 (VOIR DESCRIPTION COMPLÈTE), 3 (RETOUR LISTE) OU 4 (MENU).*',
      ],
      nextState: state,
    };
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
