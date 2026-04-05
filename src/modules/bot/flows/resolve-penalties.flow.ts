import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import { PrismaService } from 'src/common/services/prisma/prisma.service';
import type { PaymentService } from '../../payments/payment.service';

export type ResolvePenaltiesContext = {
  prisma: PrismaService;
  paymentService: PaymentService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runResolvePenaltiesFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ResolvePenaltiesContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  // Allow menu exit only after acknowledging (not on first prompt)
  if (
    state.step > 1 &&
    (CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' ')) ||
      normalized === 'retour')
  ) {
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }

  const payload = state.payload ?? {};

  // Step 1 — summary: show unpaid penalties and options
  if (state.step === 1 || !trimmed) {
    const penalties = await ctx.prisma.penalty.findMany({
      where: { worker_id: profile.id, paid_at: null },
      select: { id: true, amount: true, reason: true, applied_at: true },
      orderBy: { applied_at: 'desc' },
    });

    const count = penalties.length;
    const total = penalties.reduce((sum, p) => sum + Number(p.amount), 0);

    if (count === 0) {
      // No penalties — account should not be suspended, but handle gracefully
      return {
        reply: [
          `✅ *Aucune pénalité impayée.*\n\nVotre situation est régularisée. Tapez *MENU* pour continuer.`,
        ],
        clearState: true,
      };
    }

    const penaltyLines = penalties
      .slice(0, 5)
      .map(
        (p, i) =>
          `${i + 1}. ${Number(p.amount).toLocaleString('fr-FR')} FCFA — ${p.reason ?? 'Annulation tardive'}`,
      )
      .join('\n');

    return {
      reply: [
        [
          `⚠️ *Compte suspendu — Pénalités impayées*`,
          ``,
          `Vous avez *${count} pénalité(s) impayée(s)* pour un total de *${total.toLocaleString('fr-FR')} FCFA* :`,
          ``,
          penaltyLines,
          ``,
          `Pour réactiver votre compte, vous devez régler vos pénalités.`,
          ``,
          `*1.* 💳 Obtenir un lien de paiement`,
          `*2.* ↩️ Annuler`,
        ].join('\n'),
      ],
      nextState: {
        flowId: FLOW_IDS.RESOLVE_PENALTIES,
        step: 2,
        payload: { count, total },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // Step 2 — awaiting choice
  if (trimmed === '1') {
    const count = payload.count as number;
    const total = payload.total as number;

    const paymentUrl = await ctx.paymentService.createPaymentUrl(
      profile.id,
      total,
      `Règlement de pénalités (${count} pénalité(s))`,
    );

    return {
      reply: [
        [
          `💳 *Lien de paiement*`,
          ``,
          `Montant à régler : *${total.toLocaleString('fr-FR')} FCFA* (${count} pénalité(s))`,
          ``,
          `Cliquez sur le lien ci-dessous pour effectuer votre paiement en toute sécurité :`,
          ``,
          paymentUrl,
          ``,
          `Après le paiement, votre compte sera réactivé automatiquement.`,
          ``,
          `Tapez *MENU* pour revenir au menu principal.`,
        ].join('\n'),
      ],
      clearState: true,
    };
  }

  if (trimmed === '2') {
    return {
      reply: [
        `⚠️ *Compte toujours suspendu.*\n\nVotre compte restera suspendu jusqu'au règlement de vos pénalités.\nTapez *1* à tout moment pour voir les instructions de paiement.`,
      ],
      clearState: true,
    };
  }

  return {
    reply: [
      'Tapez *1* pour voir les instructions de paiement ou *2* pour annuler.',
    ],
    nextState: state,
  };
}

export function getResolvePenaltiesInitialState(): BotState {
  return {
    flowId: FLOW_IDS.RESOLVE_PENALTIES,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}
