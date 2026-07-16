import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { getApplyJobInitialState } from './apply-job.flow';
import {
  type CarouselCard,
  carouselReply,
  composeCardBody,
  JOB_PLACEHOLDER_KEY,
} from '../../../common/constants/whatsapp-carousel';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import {
  formatAmount,
  formatOfferDetailWithActions,
  formatRecommendedList,
  type OfferListItem,
} from '../messages/offers.messages';
import { menuMessage } from '../messages/menu.messages';

export type RecommendedJobsContext = {
  jobOfferService: JobOfferService;
  interestSignalService: InterestSignalService;
  systemConfigService: SystemConfigService;
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

async function buildApplyTeaser(
  offerId: string,
  ctx: RecommendedJobsContext,
): Promise<{ text: string; applyState: BotState } | null> {
  const offer = await ctx.jobOfferService.findById(offerId);
  if (!offer) return null;
  const fees = await ctx.systemConfigService.getFees();
  const penalty = fees.lateCancellationPenaltyFcfa;
  const threshold = fees.cancellationThresholdHours;
  const dateStr = offer.scheduled_at.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const text = [
    '*Vous êtes sur le point de postuler*',
    '',
    `*Offre*: ${offer.title}`,
    `*Date*: ${dateStr}`,
    `*Montant*: ${formatAmount(offer.amount, offer.payment_flow)}`,
    `*Adresse*: ${offer.address}`,
    '',
    '*ENGAGEMENT IMPORTANT*:',
    "Vos informations seront partagées avec l'employeur",
    'Vous vous engagez à être présent et ponctuel',
    `*Annulation < ${threshold}h avant = pénalité de ${penalty.toLocaleString('fr-FR')} FCFA*`,
    'Impact sur votre score de fiabilité',
    '',
    '*Confirmez-vous votre candidature ?*',
    '1- Oui, je postule',
    '2- Non, retour',
    '',
    '*Tapez le numéro correspondant.*',
    '',
  ].join('\n');
  return { text, applyState: getApplyJobInitialState(offerId) };
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

// Card body must be a single line — WhatsApp carousel cards reject line
// breaks — so fields get inline labels joined by " • " instead of real
// bullets. Address is unbounded free text (job title goes in the card's own
// `title` field, not here), so it's ordered last: composeCardBody truncates
// whichever field overflows the budget, and anything after it is dropped —
// putting the bounded fields (amount, date) first guarantees they're never
// the ones silently cut off.
function jobCardBody(offer: OfferListItem): string {
  const date = offer.scheduled_at.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return composeCardBody([
    { label: 'Montant', value: formatAmount(offer.amount, offer.payment_flow) },
    { label: 'Date', value: date },
    { label: 'Adresse', value: offer.address },
  ]);
}

function buildPagedListReply(
  offers: OfferListItem[],
  page: number,
): { reply: string[]; page: number } {
  const totalPages = Math.ceil(offers.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageOffers = offers.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  // Native WhatsApp carousel (one "Sélectionner" button per card, positional
  // id matches the numeric selection this list step already parses). Falls
  // back to the text list when the count is outside 2..5 (Meta requires at
  // least 2 cards per carousel).
  const cards: CarouselCard[] = pageOffers.map((o) => ({
    title: o.title,
    image: JOB_PLACEHOLDER_KEY,
    body: jobCardBody(o),
  }));
  const carousel = carouselReply('jobs', cards);
  if (carousel) {
    const nav =
      totalPages > 1
        ? `📄 Page ${safePage + 1}/${totalPages} — *S* suivante · *P* précédente · *Menu* pour revenir.`
        : 'Touchez *Sélectionner* sur une offre, ou *Menu* pour revenir.';
    return { reply: [carousel, nav], page: safePage };
  }

  return {
    reply: [formatRecommendedList(pageOffers, safePage, totalPages)],
    page: safePage,
  };
}

async function fetchOfferItems(
  offerIds: string[],
  ctx: RecommendedJobsContext,
): Promise<OfferListItem[]> {
  const results = await Promise.all(
    offerIds.map((id) => ctx.jobOfferService.findById(id)),
  );
  return results
    .filter((o): o is NonNullable<typeof o> => o != null)
    .map((o) => toOfferListItem({ ...o, acceptedCount: o.acceptedCount ?? 0 }));
}

async function handleRecommendedJobsListStep(
  state: BotState,
  payload: Record<string, unknown>,
  trimmedInput: string,
  offerIds: string[],
  profile: BotProfile,
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  const normalized = trimmedInput.toLowerCase();
  if (normalized === 'm' || normalized === 'menu') return goToMenu();

  const offers = await fetchOfferItems(offerIds, ctx);
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

  const pageOffers = offers.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const maxChoice = pageOffers.length;
  const choice = /^\d+$/.test(trimmedInput)
    ? Number.parseInt(trimmedInput, 10)
    : 0;

  if (choice < 1 || choice > maxChoice) {
    const { reply } = buildPagedListReply(offers, currentPage);
    return { reply, nextState: state };
  }

  const item = pageOffers[choice - 1];

  void ctx.interestSignalService
    .record(profile.id, item.id, 'view')
    .catch(() => undefined);

  return {
    reply: [formatOfferDetailWithActions(item)],
    nextState: buildDetailState(state, payload, item.id),
  };
}

async function handleRecommendedJobsDetailStep(
  state: BotState,
  payload: Record<string, unknown>,
  normalizedInput: string,
  offerIds: string[],
  profile: BotProfile,
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  const selectedOfferId = payload.selectedOfferId as string;

  // 1 — Postuler
  if (normalizedInput === '1' || normalizedInput === 'postuler') {
    if (profile.profile_type !== 'WORKER') {
      return {
        reply: ['❌ Seuls les travailleurs peuvent postuler à une offre.'],
        nextState: state,
      };
    }
    void ctx.interestSignalService
      .record(profile.id, selectedOfferId, 'apply')
      .catch(() => undefined);
    const teaser = await buildApplyTeaser(selectedOfferId, ctx);
    if (!teaser) {
      return {
        reply: ['❌ Offre introuvable. Tapez *Menu*.'],
        clearState: true,
      };
    }
    return { reply: [teaser.text], nextState: teaser.applyState };
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
          '2- Retour à la liste',
          '3- Menu principal',
          '',
          'Tapez le numéro correspondant.',
        ].join('\n'),
      ],
      nextState: { ...state, payload: { ...payload, step: 'description' } },
    };
  }

  // 3 — Retour à la liste
  if (normalizedInput === '3' || normalizedInput === 'retour') {
    void ctx.interestSignalService
      .record(profile.id, selectedOfferId, 'skip')
      .catch(() => undefined);
    const offers = await fetchOfferItems(offerIds, ctx);
    const currentPage = typeof payload.page === 'number' ? payload.page : 0;
    const { reply } = buildPagedListReply(offers, currentPage);
    return {
      reply,
      nextState: buildListState(state, payload),
    };
  }

  // 4 / explicit menu commands → exit; anything else → re-show detail
  if (normalizedInput === '4' || isMenuCommand(normalizedInput))
    return goToMenu();

  const offer = await ctx.jobOfferService.findById(selectedOfferId);
  if (!offer) return goToMenu();
  const item = toOfferListItem({
    ...offer,
    acceptedCount: offer.acceptedCount ?? 0,
  });
  return { reply: [formatOfferDetailWithActions(item)], nextState: state };
}

async function handleRecommendedJobsDescriptionStep(
  state: BotState,
  payload: Record<string, unknown>,
  normalizedInput: string,
  offerIds: string[],
  profile: BotProfile,
  ctx: RecommendedJobsContext,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  const selectedOfferId = payload.selectedOfferId as string;

  // 1 — Postuler
  if (normalizedInput === '1' || normalizedInput === 'postuler') {
    if (profile.profile_type !== 'WORKER') {
      return {
        reply: ['❌ Seuls les travailleurs peuvent postuler à une offre.'],
        nextState: state,
      };
    }
    void ctx.interestSignalService
      .record(profile.id, selectedOfferId, 'apply')
      .catch(() => undefined);
    const teaser = await buildApplyTeaser(selectedOfferId, ctx);
    if (!teaser) {
      return {
        reply: ['❌ Offre introuvable. Tapez *Menu*.'],
        clearState: true,
      };
    }
    return { reply: [teaser.text], nextState: teaser.applyState };
  }

  // 2 — Retour fiche offre
  if (normalizedInput === '2') {
    const offer = await ctx.jobOfferService.findById(selectedOfferId);
    if (!offer) return { reply: ['Offre introuvable.'], nextState: state };
    const item = toOfferListItem({
      ...offer,
      acceptedCount: offer.acceptedCount ?? 0,
    });
    return {
      reply: [formatOfferDetailWithActions(item)],
      nextState: { ...state, payload: { ...payload, step: 'detail' } },
    };
  }

  // 3 / explicit menu commands → exit; anything else → re-show description
  if (normalizedInput === '3' || isMenuCommand(normalizedInput))
    return goToMenu();

  const offer = await ctx.jobOfferService.findById(selectedOfferId);
  if (!offer) return goToMenu();
  return {
    reply: [
      [
        `*${offer.title}*`,
        '',
        offer.description,
        '',
        '1- Postuler à cette offre',
        '2- Retour à la liste',
        '3- Menu principal',
        '',
        'Tapez le numéro correspondant.',
      ].join('\n'),
    ],
    nextState: state,
  };
}

export async function runRecommendedJobsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedJobsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const offerIds = (payload.offerIds as string[] | undefined) ?? [];
  const step = (payload.step as RecommendedStep | 'description') ?? 'list';
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (isMenuCommand(normalized)) return goToMenu();

  if (offerIds.length === 0) {
    return {
      reply: [
        '*Aucune offre recommandée pour le moment. Tapez *Menu* pour revenir.*',
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
      offerIds,
      profile,
      ctx,
      goToMenu,
    );
  }

  if (step === 'description') {
    return await handleRecommendedJobsDescriptionStep(
      state,
      payload,
      normalized,
      offerIds,
      profile,
      ctx,
      goToMenu,
    );
  }

  return {
    reply: ['❌ Erreur. Tapez *Menu* pour revenir.'],
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
