import { PaymentFlow } from '@prisma/client';
import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import { formatOfferPublishedSuccess } from '../messages/offers.messages';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import { CreateJobOfferDto } from '../../job-offer/dto/create-job-offer.dto';

const TITLE_MIN = 5;
const TITLE_MAX = 100;
const DESC_MIN = 20;
const DESC_MAX = 1000;
const AMOUNT_MIN = 1000;
const AMOUNT_MAX = 1_000_000;
const ADDRESS_MIN = 10;
const NOTE_MAX = 500;
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 100;
const MIN_HOURS_FROM_NOW = 4;

const PAYMENT_FLOW_LABELS: Record<string, string> = {
  HOURLY: 'Par heure',
  DAILY: 'Par jour',
  MONTHLY: 'Par mois',
};

export type PublishJobContext = {
  jobOfferService: JobOfferService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type StepArgs = {
  state: BotState;
  payload: Record<string, unknown>;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: PublishJobContext;
};

function formatDateTime(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const DATE_TIME_REGEX = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/;

function parseDateTime(input: string): Date | null {
  const trimmed = input.trim();
  const match = DATE_TIME_REGEX.exec(trimmed);
  if (!match) return null;
  const [, day, month, year, hour, min] = match;
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hour === undefined ||
    min === undefined
  ) {
    return null;
  }
  const d = new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(min, 10),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function toScheduledAtString(scheduledAt: unknown): string {
  if (scheduledAt instanceof Date) return scheduledAt.toISOString();
  if (typeof scheduledAt === 'string') return scheduledAt;
  return '';
}

// Step 9 — publish the offer (formerly step 8)
async function handlePublishStep9(args: StepArgs): Promise<FlowResult> {
  const { state, payload, profile, ctx } = args;
  const scheduledStr = toScheduledAtString(payload.scheduled_at);
  const noteValue = typeof payload.note === 'string' ? payload.note : undefined;
  const dto: CreateJobOfferDto = {
    title: String(payload.title),
    description: String(payload.description),
    scheduled_at: scheduledStr,
    amount: Number(payload.amount),
    payment_flow: payload.payment_flow as PaymentFlow,
    address: String(payload.address),
    note: noteValue,
    quantity: Number(payload.quantity),
  };
  try {
    const offer = await ctx.jobOfferService.create(profile.id, dto);
    return { reply: [formatOfferPublishedSuccess(offer.id)], clearState: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Erreur lors de la publication.';
    return {
      reply: [`❌ ${message} Réessayez ou tapez 'Menu' pour annuler.`],
      nextState: state,
    };
  }
}

// Step 9 (confirmation screen) — "Modifier" branch → step 10
function handleStep9Modifier(
  state: BotState,
  payload: Record<string, unknown>,
  normalized: string,
): FlowResult | null {
  if (state.step !== 9 || (normalized !== '2' && normalized !== 'modifier'))
    return null;
  return {
    reply: [
      [
        'Quelle étape souhaitez-vous modifier ? (1-8)',
        '1=Titre, 2=Description, 3=Date/heure, 4=Montant, 5=Type rémunération, 6=Adresse, 7=Nombre de personnes, 8=Note',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 10,
      payload: { ...payload },
      updatedAt: new Date().toISOString(),
    },
  };
}

// Step 10 — modifier selection (formerly step 9)
function handleStep10(
  state: BotState,
  payload: Record<string, unknown>,
  trimmed: string,
): FlowResult | null {
  if (state.step !== 10) return null;
  const num = Number.parseInt(trimmed, 10);
  if (num >= 1 && num <= 8) {
    return {
      reply: [getStepPrompt(num, payload)],
      nextState: {
        ...state,
        step: num,
        payload: { ...payload, modifyingStep: num },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  return {
    reply: ['Numéro invalide. Tapez un nombre entre 1 et 8.'],
    nextState: state,
  };
}

// Step 9 — confirmation screen handler
async function handleStep9Confirm(
  args: StepArgs,
  normalized: string,
): Promise<FlowResult | null> {
  if (args.state.step !== 9) return null;
  if (
    normalized === '1' ||
    normalized === 'oui' ||
    normalized === 'oui, publier'
  ) {
    return handlePublishStep9(args);
  }
  if (normalized === '3' || normalized === 'annuler') {
    return {
      reply: ["Publication annulée. Tapez 'Menu' pour revenir au menu."],
      clearState: true,
    };
  }
  return {
    reply: ['Répondez par 1 (Oui), 2 (Modifier) ou 3 (Annuler).'],
    nextState: args.state,
  };
}

function getStepHandler(step: number): ((args: StepArgs) => FlowResult) | null {
  const handlers: Record<number, (args: StepArgs) => FlowResult> = {
    1: handlePublishStep1,
    2: handlePublishStep2,
    3: handlePublishStep3,
    4: handlePublishStep4,
    5: handlePublishStep5,
    6: handlePublishStep6,
    7: handlePublishStep7,
    8: handlePublishStep8,
  };
  return handlers[step] ?? null;
}

export async function runPublishJobFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: PublishJobContext,
): Promise<FlowResult> {
  const step = state.step;
  const payload = state.payload ?? {};
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();
  const args: StepArgs = {
    state,
    payload,
    trimmed,
    normalized,
    profile,
    ctx,
  };

  if (profile.profile_type !== 'EMPLOYER') {
    return {
      reply: [
        "❌ Seuls les employeurs peuvent publier des offres. Votre compte est de type Worker. Tapez 'Menu' pour voir les options.",
      ],
      clearState: true,
    };
  }

  // Global exit — any step
  if (
    normalized === 'exit' ||
    normalized === 'annuler' ||
    normalized === 'quitter' ||
    normalized === 'cancel'
  ) {
    return {
      reply: ["Publication annulée. Tapez 'Menu' pour revenir au menu."],
      clearState: true,
    };
  }

  const step9Modifier = handleStep9Modifier(state, payload, normalized);
  if (step9Modifier) return step9Modifier;

  const step10Result = handleStep10(state, payload, trimmed);
  if (step10Result) return step10Result;

  const step9Result = await handleStep9Confirm(args, normalized);
  if (step9Result) return step9Result;

  const stepHandler = getStepHandler(step);
  if (stepHandler) return stepHandler(args);

  return {
    reply: ["Erreur d'étape. Tapez 'Menu' pour annuler."],
    clearState: true,
  };
}

function handlePublishStep1(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed) {
    return {
      reply: [
        [
          "*PUBLICATION D'OFFRE* - ÉTAPE 1/8",
          '',
          '*Quel est le titre de votre offre ?*',
          '',
          '*Exemple*: "_Plombier pour réparation urgente_"',
          '',
          '_Tapez "Annuler" à tout moment pour abandonner._',
        ].join('\n'),
      ],
      nextState: state,
    };
  }
  if (trimmed.length < TITLE_MIN || trimmed.length > TITLE_MAX) {
    return {
      reply: [
        `*Le titre doit contenir entre ${TITLE_MIN} et ${TITLE_MAX} caractères.*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 2/8*',
        '',
        '*Décrivez votre offre en détail. Soyez précis sur les tâches à réaliser.*',
        '',
        '*Exemple*: "_Réparation fuite d\'eau cuisine, remplacement robinet, vérification tuyauterie_"',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 2,
      payload: { ...payload, title: trimmed },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handlePublishStep2(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed) {
    return {
      reply: [
        '*Décrivez votre offre en détail (entre 20 et 1000 caractères).*',
      ],
      nextState: state,
    };
  }
  if (trimmed.length < DESC_MIN || trimmed.length > DESC_MAX) {
    return {
      reply: [
        `*La description doit contenir entre ${DESC_MIN} et ${DESC_MAX} caractères.*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 3/8*',
        '',
        '*À quelle date et heure le travail doit-il commencer ?*',
        'Format: JJ/MM/AAAA HH:MM',
        '',
        '*Exemple*: "_15/02/2026 09:00_"',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 3,
      payload: { ...payload, description: trimmed },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handlePublishStep3(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed) {
    return {
      reply: [
        "*Entrez la date et l'heure au format JJ/MM/AAAA HH:MM (ex: 15/02/2026 09:00)*",
      ],
      nextState: state,
    };
  }
  const dt = parseDateTime(trimmed);
  if (!dt) {
    return {
      reply: [
        '*Format invalide ou date invalide. Utilisez JJ/MM/AAAA HH:MM et choisissez une date future.*',
      ],
      nextState: state,
    };
  }
  const now = new Date();
  const minDate = new Date(now.getTime() + MIN_HOURS_FROM_NOW * 60 * 60 * 1000);
  if (dt < minDate) {
    return {
      reply: [
        `*La date doit être au moins ${MIN_HOURS_FROM_NOW} heures dans le futur.*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 4/8*',
        '',
        '*Quel est le montant proposé (en FCFA) ?*',
        'Tapez uniquement le chiffre.',
        '',
        '*Exemple*: "_15000_"',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 4,
      payload: { ...payload, scheduled_at: dt.toISOString() },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handlePublishStep4(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed) {
    return {
      reply: ['*Entrez le montant en FCFA (entre 1 000 et 1 000 000).*'],
      nextState: state,
    };
  }
  const amount = Number.parseInt(trimmed.replaceAll(/\s/g, ''), 10);
  if (Number.isNaN(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
    return {
      reply: [
        `*Montant invalide. Entrez un montant entre ${AMOUNT_MIN.toLocaleString('fr-FR')} et ${AMOUNT_MAX.toLocaleString('fr-FR')} FCFA*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 5/8*',
        '',
        '*Type de rémunération ?*',
        '1️⃣ Par heure',
        '2️⃣ Par jour',
        '3️⃣ Par mois',
        '',
        '*Tapez le numéro correspondant.*',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 5,
      payload: { ...payload, amount },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handlePublishStep5(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  const num = parsePaymentFlowChoice(trimmed);
  if (!num) {
    return {
      reply: ['*Choix invalide. Tapez le numéro correspondant.*'],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 6/8*',
        '',
        "*Quelle est l'adresse complète du lieu de travail ?*",
        '',
        '*Exemple*: "_123 Avenue de la Paix, Poto-Poto, Brazzaville_"',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 6,
      payload: { ...payload, payment_flow: num },
      updatedAt: new Date().toISOString(),
    },
  };
}

function handlePublishStep6(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed || trimmed.length < ADDRESS_MIN) {
    return {
      reply: [
        `*L'adresse doit contenir au moins ${String(ADDRESS_MIN)} caractères.*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 7/8*',
        '',
        "*Combien de personnes sont nécessaires pour ce travail ?*",
        `Entrez un nombre entre ${QUANTITY_MIN} et ${QUANTITY_MAX}.`,
        '',
        '*Exemple*: "_2_"',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 7,
      payload: { ...payload, address: trimmed },
      updatedAt: new Date().toISOString(),
    },
  };
}

// Step 7 — quantity (new step)
function handlePublishStep7(args: StepArgs): FlowResult {
  const { state, payload, trimmed } = args;
  if (!trimmed) {
    return {
      reply: [
        `*Entrez le nombre de personnes nécessaires (${QUANTITY_MIN}-${QUANTITY_MAX}).*`,
      ],
      nextState: state,
    };
  }
  const quantity = Number.parseInt(trimmed, 10);
  if (
    Number.isNaN(quantity) ||
    quantity < QUANTITY_MIN ||
    quantity > QUANTITY_MAX
  ) {
    return {
      reply: [
        `*Nombre invalide. Entrez un nombre entre ${QUANTITY_MIN} et ${QUANTITY_MAX}.*`,
      ],
      nextState: state,
    };
  }
  return {
    reply: [
      [
        '*ÉTAPE 8/8 (OPTIONNEL)*',
        '',
        '*Avez-vous une note complémentaire à ajouter ?*',
        '',
        '*Exemple*: "_Apporter vos propres outils_"',
        '*Tapez "Non" ou "Passer" pour ignorer la note.*',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 8,
      payload: { ...payload, quantity },
      updatedAt: new Date().toISOString(),
    },
  };
}

// Step 8 — note (formerly step 7)
function handlePublishStep8(args: StepArgs): FlowResult {
  const { state, payload, trimmed, normalized } = args;
  const note =
    normalized === 'non' || normalized === 'passer' || normalized === 'skip'
      ? null
      : trimmed;
  if (note != null && note.length > NOTE_MAX) {
    return {
      reply: [`*La note ne peut pas dépasser ${NOTE_MAX} caractères.*`],
      nextState: state,
    };
  }
  const fullPayload = { ...payload, note: note ?? '' };
  const summary = buildSummary(fullPayload);
  return {
    reply: [
      [
        '*RÉCAPITULATIF DE VOTRE OFFRE* :',
        '',
        summary,
        '',
        '*Confirmez-vous la publication de cette offre ?*',
        '1️⃣ Oui, publier',
        '2️⃣ Modifier',
        '3️⃣ Annuler',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 9,
      payload: fullPayload,
      updatedAt: new Date().toISOString(),
    },
  };
}

function getStepPrompt(
  stepNum: number,
  payload: Record<string, unknown>,
): string {
  switch (stepNum) {
    case 1:
      return 'Quel est le titre de votre offre ? (5-100 caractères)';
    case 2:
      return 'Décrivez votre offre en détail. (20-1000 caractères)';
    case 3:
      return 'À quelle date et heure ? Format JJ/MM/AAAA HH:MM';
    case 4:
      return 'Quel est le montant en FCFA ? (1000-1000000)';
    case 5:
      return 'Type de rémunération : 1=Par heure, 2=Par jour, 3=Par mois';
    case 6:
      return "Quelle est l'adresse du lieu de travail ?";
    case 7:
      return `Combien de personnes sont nécessaires ? (${QUANTITY_MIN}-${QUANTITY_MAX})`;
    case 8:
      return 'Note complémentaire (ou "Non" pour passer)';
    default:
      return '';
  }
}

function formatScheduledAt(scheduledAt: unknown): string {
  if (scheduledAt instanceof Date) return formatDateTime(scheduledAt);
  if (typeof scheduledAt === 'string')
    return formatDateTime(new Date(scheduledAt));
  return '-';
}

function formatPaymentFlowLabel(paymentFlow: unknown): string {
  if (paymentFlow == null) return '-';
  if (typeof paymentFlow === 'string')
    return PAYMENT_FLOW_LABELS[paymentFlow] ?? paymentFlow;
  if (typeof paymentFlow === 'number' || typeof paymentFlow === 'boolean') {
    const key = String(paymentFlow);
    return PAYMENT_FLOW_LABELS[key] ?? key;
  }
  return '-';
}

/** Safe string for display; avoids [object Object] for non-primitive values. */
function toDisplayString(v: unknown): string {
  if (v == null) return '-';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '-';
}

function parsePaymentFlowChoice(
  trimmed: string,
): 'HOURLY' | 'DAILY' | 'MONTHLY' | null {
  if (trimmed === '1') return 'HOURLY';
  if (trimmed === '2') return 'DAILY';
  if (trimmed === '3') return 'MONTHLY';
  return null;
}

function buildSummary(payload: Record<string, unknown>): string {
  const scheduled = formatScheduledAt(payload.scheduled_at);
  const flow = formatPaymentFlowLabel(payload.payment_flow);
  const title = toDisplayString(payload.title);
  const desc = payload.description;
  const descStr = typeof desc === 'string' ? `${desc.slice(0, 80)}...` : '-';
  const address = toDisplayString(payload.address);
  const quantity =
    typeof payload.quantity === 'number' ? String(payload.quantity) : '1';
  const note =
    payload.note == null || typeof payload.note !== 'string'
      ? 'Aucune'
      : payload.note;
  return [
    `*Titre*: ${title}`,
    `📝 Description: ${descStr}`,
    `*Date et heure*: ${scheduled}`,
    `*Montant*: ${Number(payload.amount ?? 0).toLocaleString('fr-FR')} FCFA ${flow}`,
    `*Adresse*: ${address}`,
    `*Nombre de personnes*: ${quantity}`,
    `*Note*: ${note}`,
  ].join('\n');
}

export function getPublishJobInitialState(): BotState {
  return {
    flowId: FLOW_IDS.PUBLISH_JOB,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

export function getPublishJobFirstMessage(): string {
  return [
    "*PUBLICATION D'OFFRE* - ÉTAPE 1/8",
    '',
    '*Quel est le titre de votre offre ?*',
    '',
    '*Exemple*: "_Plombier pour réparation urgente_"',
    '',
    '_Tapez "Annuler" à tout moment pour abandonner._',
  ].join('\n');
}
