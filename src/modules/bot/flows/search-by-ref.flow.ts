import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatAmount,
  formatOfferDetailWithActions,
  jobOfferToOfferListItem,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';
import { getApplyJobInitialState } from './apply-job.flow';
import { normalizeJobReference } from '../../job-offer/utils/job-reference.util';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { SystemConfigService } from '../../system-config/system-config.service';

export type SearchByRefContext = {
  jobOfferService: JobOfferService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type SearchStep = 'ref' | 'detail' | 'description';

export function getSearchByRefInitialState(): BotState {
  return {
    flowId: FLOW_IDS.SEARCH_BY_REF,
    step: 0,
    payload: { step: 'ref' as SearchStep },
    updatedAt: new Date().toISOString(),
  };
}

export function getSearchByRefPromptMessage(): string {
  return [
    '*Rechercher une offre par référence*',
    '',
    "Entrez la référence de l'offre (exemple : *RBT-7K3X9*).",
    '',
    'Tapez *Menu* pour annuler.',
  ].join('\n');
}

function backToRefPrompt(state: BotState): FlowResult {
  return {
    reply: [getSearchByRefPromptMessage()],
    nextState: {
      ...state,
      payload: { step: 'ref' as SearchStep },
      updatedAt: new Date().toISOString(),
    },
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

async function handleRefStep(
  state: BotState,
  trimmed: string,
  ctx: SearchByRefContext,
): Promise<FlowResult> {
  if (!trimmed) {
    return { reply: [getSearchByRefPromptMessage()], nextState: state };
  }

  const ref = normalizeJobReference(trimmed);
  const offer = await ctx.jobOfferService.findByReference(ref);
  if (!offer) {
    return {
      reply: [
        `❌ Aucune offre trouvée pour la référence *${ref}*.\n\nRéessayez ou tapez *Menu* pour annuler.`,
      ],
      nextState: state,
    };
  }

  const remaining = Math.max(0, offer.quantity - (offer.acceptedCount ?? 0));
  if (offer.status !== 'ACTIVE' && offer.status !== 'PARTIALLY_FILLED') {
    return {
      reply: [
        "❌ Cette offre n'est plus disponible. Tapez *Menu* pour revenir.",
      ],
      clearState: true,
    };
  }
  if (remaining === 0) {
    return {
      reply: ['❌ Cette offre est complète. Tapez *Menu* pour revenir.'],
      clearState: true,
    };
  }

  return {
    reply: [formatOfferDetailWithActions(jobOfferToOfferListItem(offer))],
    nextState: {
      ...state,
      payload: { step: 'detail' as SearchStep, offerId: offer.id },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleDetailApply(
  state: BotState,
  offerId: string,
  profile: BotProfile,
  ctx: SearchByRefContext,
): Promise<FlowResult> {
  if (profile.profile_type !== 'WORKER') {
    return {
      reply: ['❌ Seuls les travailleurs peuvent postuler à une offre.'],
      nextState: state,
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
  ].join('\n');
  return { reply: [text], nextState: getApplyJobInitialState(offerId) };
}

async function handleDetailStep(
  state: BotState,
  trimmed: string,
  profile: BotProfile,
  ctx: SearchByRefContext,
): Promise<FlowResult> {
  const offerId = state.payload?.offerId as string | undefined;
  if (!offerId) {
    return backToRefPrompt(state);
  }

  if (trimmed === '1') {
    return handleDetailApply(state, offerId, profile, ctx);
  }
  if (trimmed === '2') {
    const offer = await ctx.jobOfferService.findById(offerId);
    if (!offer) {
      return {
        reply: ['*Offre introuvable. Tapez *Menu*.*'],
        clearState: true,
      };
    }
    const descText = [
      `*${offer.title}*`,
      '',
      offer.description,
      '',
      '1- Postuler à cette offre',
      '2- Retour à la fiche',
      '3- Menu',
      '',
      'Tapez le numéro correspondant.',
    ].join('\n');
    return {
      reply: [descText],
      nextState: {
        ...state,
        payload: { step: 'description' as SearchStep, offerId },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  if (trimmed === '3') {
    return backToRefPrompt(state);
  }
  if (trimmed === '4') {
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }
  return {
    reply: [
      'Répondez par 1 (Postuler), 2 (Voir description complète), 3 (Nouvelle référence) ou 4 (Menu).',
    ],
    nextState: state,
  };
}

async function handleDescriptionStep(
  state: BotState,
  trimmed: string,
  profile: BotProfile,
  ctx: SearchByRefContext,
): Promise<FlowResult> {
  const offerId = state.payload?.offerId as string | undefined;
  if (!offerId) return backToRefPrompt(state);

  // '1' = apply, '2' = back to detail card
  if (trimmed === '1') {
    return handleDetailApply(state, offerId, profile, ctx);
  }
  if (trimmed === '2') {
    const offer = await ctx.jobOfferService.findById(offerId);
    if (!offer)
      return {
        reply: ['*Offre introuvable. Tapez *Menu*.*'],
        clearState: true,
      };
    return {
      reply: [formatOfferDetailWithActions(jobOfferToOfferListItem(offer))],
      nextState: {
        ...state,
        payload: { step: 'detail' as SearchStep, offerId },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  if (trimmed === '3' || CMD_MENU.some((c) => trimmed.toLowerCase() === c)) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }
  return {
    reply: ['Répondez par 1 (Postuler), 2 (Retour à la fiche) ou 3 (Menu).'],
    nextState: state,
  };
}

export async function runSearchByRefFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: SearchByRefContext,
): Promise<FlowResult> {
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

  if (profile.profile_type !== 'WORKER') {
    return {
      reply: [
        '❌ Seuls les travailleurs peuvent rechercher une offre par référence. Tapez *Menu*.',
      ],
      clearState: true,
    };
  }

  const step = (state.payload?.step as SearchStep | undefined) ?? 'ref';
  if (step === 'detail') {
    return handleDetailStep(state, trimmed, profile, ctx);
  }
  if (step === 'description') {
    return handleDescriptionStep(state, trimmed, profile, ctx);
  }
  return handleRefStep(state, trimmed, ctx);
}
