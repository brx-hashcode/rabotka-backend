import { PaymentFlow } from '@prisma/client';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowResult } from '../types/flow.types';
import type { JobOfferService } from '../../job-offer/job-offer.service';
import { CMD_MENU } from '../bot.constants';
import {
  parseDateTime,
  toScheduledAtString,
  formatDateTime,
  MIN_HOURS_FROM_NOW,
} from '../utils/parse-date-time';

export type RepublishExpiredJobContext = {
  prisma: PrismaService;
  jobOfferService: JobOfferService;
};

function isMenuInput(normalized: string): boolean {
  return (
    CMD_MENU.includes(normalized) ||
    normalized === '2' ||
    normalized === 'annuler'
  );
}

const MENU_REPLY: FlowResult = {
  reply: ['Tapez *MENU* pour accéder au menu principal.'],
  clearState: true,
};

async function handleStep0(
  state: BotState,
  trimmed: string,
  normalized: string,
  profile: BotProfile,
  ctx: RepublishExpiredJobContext,
): Promise<FlowResult> {
  if (isMenuInput(normalized)) return MENU_REPLY;

  if (normalized !== '1' && normalized !== 'republier') {
    return {
      reply: [
        [
          `*⏰ Offre expirée*`,
          '',
          `Que souhaitez-vous faire ?`,
          '',
          `1- Republier l'offre`,
          `2- Menu`,
        ].join('\n'),
      ],
      nextState: state,
    };
  }

  const jobOfferId = state.payload.jobOfferId as string | undefined;
  if (!jobOfferId) return MENU_REPLY;

  const job = await ctx.prisma.jobOffer.findUnique({
    where: { id: jobOfferId },
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
  });

  if (!job || job.employer_id !== profile.id) {
    return {
      reply: [`❌ Offre introuvable. Tapez *MENU* pour continuer.`],
      clearState: true,
    };
  }

  return {
    reply: [
      [
        `*📅 Republication de l'offre*`,
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
        jobOfferId: job.id,
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

  const minDate = new Date(
    Date.now() + MIN_HOURS_FROM_NOW * 60 * 60 * 1000,
  );
  if (dt < minDate) {
    return {
      reply: [
        `*La date doit être au moins ${MIN_HOURS_FROM_NOW} heures dans le futur.*\n\nTapez *MENU* pour annuler.`,
      ],
      nextState: state,
    };
  }

  const payload = state.payload;
  try {
    await ctx.jobOfferService.create(profile.id, {
      title: String(payload.title),
      description: String(payload.description),
      scheduled_at: toScheduledAtString(dt),
      ...(payload.amount != null
        ? { amount: Number(payload.amount) }
        : {}),
      ...(payload.payment_flow
        ? { payment_flow: payload.payment_flow as PaymentFlow }
        : {}),
      address: String(payload.address),
      ...(payload.note ? { note: String(payload.note) } : {}),
      quantity: Number(payload.quantity ?? 1),
    });

    return {
      reply: [
        [
          `✅ *Offre republiée !*`,
          '',
          `Votre offre *"${String(payload.title)}"* a été republiée pour le *${formatDateTime(dt)}*.`,
          `Les travailleurs peuvent à nouveau y postuler.`,
          '',
          `Tapez *MENU* pour revenir au menu.`,
        ].join('\n'),
      ],
      clearState: true,
    };
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
