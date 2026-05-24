import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowResult } from '../types/flow.types';
import { CMD_MENU } from '../bot.constants';
import {
  parseDateTime,
  formatDateTime,
  MIN_HOURS_FROM_NOW,
} from '../utils/parse-date-time';

export type RepublishExpiredJobContext = {
  prisma: PrismaService;
};

type ExpiredJobLite = {
  id: string;
  title: string;
  description: string;
  address: string | null;
  amount: import('@prisma/client').Prisma.Decimal | number;
  payment_flow: string | null;
  quantity: number;
  note: string | null;
  employer_id: string;
};

function isMenuInput(normalized: string): boolean {
  return CMD_MENU.includes(normalized) || normalized === 'annuler';
}

const MENU_REPLY: FlowResult = {
  reply: ['Tapez *MENU* pour accéder au menu principal.'],
  clearState: true,
};

/** Pull the queue out of the payload, tolerating the legacy single-id shape. */
function readQueue(payload: Record<string, unknown>): string[] {
  const ids = payload.jobOfferIds;
  if (Array.isArray(ids)) {
    return ids.filter((v): v is string => typeof v === 'string');
  }
  const single = payload.jobOfferId;
  return typeof single === 'string' ? [single] : [];
}

function expiredPrompt(title?: string): string {
  return [
    `*⏰ Offre expirée*`,
    '',
    title
      ? `Votre offre *"${title}"* a expiré.`
      : 'Votre offre a expiré.',
    '',
    `Que souhaitez-vous faire ?`,
    '',
    `1- Republier l'offre`,
    `2- Passer cette offre`,
  ].join('\n');
}

/**
 * Builds the next state by dropping `count` offers from the front of the
 * queue. Returns either the next-prompt result, or a terminal MENU_REPLY
 * if the queue is now empty.
 */
async function advanceQueue(
  state: BotState,
  drop: number,
  precedingReply: string | null,
  ctx: RepublishExpiredJobContext,
  profileId: string,
): Promise<FlowResult> {
  const queue = readQueue(state.payload).slice(drop);
  if (queue.length === 0) {
    return {
      reply: precedingReply
        ? [precedingReply, 'Tapez *MENU* pour revenir au menu.']
        : MENU_REPLY.reply,
      clearState: true,
    };
  }

  // Look up the next offer's title so the prompt is specific.
  const next = await ctx.prisma.jobOffer.findUnique({
    where: { id: queue[0] },
    select: { title: true, employer_id: true },
  });
  if (!next || next.employer_id !== profileId) {
    // Skip stale/unauthorised id and recurse on the rest.
    return advanceQueue(
      { ...state, payload: { ...state.payload, jobOfferIds: queue } },
      1,
      precedingReply,
      ctx,
      profileId,
    );
  }

  const prompt = expiredPrompt(next.title);
  return {
    reply: precedingReply ? [precedingReply, prompt] : [prompt],
    nextState: {
      ...state,
      step: 0,
      payload: { jobOfferIds: queue },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleStep0(
  state: BotState,
  _trimmed: string,
  normalized: string,
  profile: BotProfile,
  ctx: RepublishExpiredJobContext,
): Promise<FlowResult> {
  const queue = readQueue(state.payload);
  const currentId = queue[0];

  // Global menu: abandon all pending offers.
  if (isMenuInput(normalized) && normalized !== '2') {
    return MENU_REPLY;
  }

  // "2" = skip this offer and move on to the next in the queue (or menu).
  if (normalized === '2') {
    return advanceQueue(state, 1, null, ctx, profile.id);
  }

  if (normalized !== '1' && normalized !== 'republier') {
    return {
      reply: [expiredPrompt()],
      nextState: state,
    };
  }

  if (!currentId) return MENU_REPLY;

  const job = (await ctx.prisma.jobOffer.findUnique({
    where: { id: currentId },
    select: {
      id: true,
      title: true,
      description: true,
      address: true,
      amount: true,
      payment_flow: true,
      quantity: true,
      note: true,
      employer_id: true,
    },
  })) as ExpiredJobLite | null;

  if (!job || job.employer_id !== profile.id) {
    // Unauthorised or vanished — drop this id and try the next one.
    return advanceQueue(state, 1, '❌ Offre introuvable.', ctx, profile.id);
  }

  return {
    reply: [
      [
        `*Republication de l'offre*`,
        '',
        `Votre offre *"${job.title}"* sera republiée avec les mêmes informations.`,
        '',
        `Entrez la nouvelle date et heure au format *JJ/MM/AAAA HH:MM* :`,
        `(ex: 25/05/2026 09:00)`,
        '',
        `Tapez *MENU* pour annuler.`,
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 1,
      payload: {
        jobOfferIds: queue,
        title: job.title,
        description: job.description,
        address: job.address ?? '',
        amount: job.amount,
        payment_flow: job.payment_flow,
        quantity: job.quantity,
        note: job.note ?? '',
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleStep1(
  state: BotState,
  trimmed: string,
  normalized: string,
  profile: BotProfile,
  ctx: RepublishExpiredJobContext,
): Promise<FlowResult> {
  if (isMenuInput(normalized)) return MENU_REPLY;

  const dt = parseDateTime(trimmed);
  if (!dt) {
    return {
      reply: [
        `*Format invalide.* Utilisez *JJ/MM/AAAA HH:MM* (ex: 25/05/2026 09:00)\n\nTapez *MENU* pour annuler.`,
      ],
      nextState: state,
    };
  }

  const minDate = new Date(Date.now() + MIN_HOURS_FROM_NOW * 60 * 60 * 1000);
  if (dt < minDate) {
    return {
      reply: [
        `*La date doit être au moins ${MIN_HOURS_FROM_NOW} heures dans le futur.*\n\nTapez *MENU* pour annuler.`,
      ],
      nextState: state,
    };
  }

  const payload = state.payload;
  const queue = readQueue(payload);
  const currentId = queue[0];
  if (!currentId) return MENU_REPLY;

  try {
    await ctx.prisma.jobOffer.update({
      where: { id: currentId },
      data: {
        scheduled_at: dt,
        status: 'ACTIVE',
      },
    });

    const successMsg = [
      `✅ *Offre republiée !*`,
      '',
      `Votre offre *"${String(payload.title)}"* a été republiée pour le *${formatDateTime(dt)}*.`,
      `Les travailleurs peuvent à nouveau y postuler.`,
    ].join('\n');

    // Drop the current offer and, if more remain, show the next prompt
    // in the same reply. Otherwise terminate with the success message.
    return advanceQueue(state, 1, successMsg, ctx, profile.id);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Erreur lors de la republication.';
    return {
      reply: [`❌ ${message} Réessayez ou tapez *MENU* pour annuler.`],
      nextState: state,
    };
  }
}

export async function runRepublishExpiredJobFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RepublishExpiredJobContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (state.step === 0) {
    return handleStep0(state, trimmed, normalized, profile, ctx);
  }
  if (state.step === 1) {
    return handleStep1(state, trimmed, normalized, profile, ctx);
  }

  return MENU_REPLY;
}
