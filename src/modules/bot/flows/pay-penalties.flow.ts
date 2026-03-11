import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';

export type PayPenaltiesContext = {
  applicationService: ApplicationService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runPayPenaltiesFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: PayPenaltiesContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' ')) ||
    normalized === 'retour' ||
    trimmed === '2'
  ) {
    return goToMenu();
  }

  const payload = state.payload ?? {};
  const totalAmount = payload.totalAmount as number;
  const penaltyCount = payload.penaltyCount as number;

  if (trimmed === '1') {
    const result = await ctx.applicationService.markPenaltiesPaid(profile.id);
    if (result.paidCount === 0) {
      return {
        reply: [
          `✅ *Aucune pénalité en attente.*\n\nVotre compte est en règle. Tapez *MENU* pour continuer.`,
        ],
        clearState: true,
      };
    }
    return {
      reply: [
        [
          `✅ *Paiement enregistré*`,
          ``,
          `Merci ! Vos *${result.paidCount} pénalité(s)* (${result.totalAmount.toLocaleString('fr-FR')} FCFA) ont été marquées comme réglées.`,
          ``,
          `Votre compte est maintenant *débloqué* — vous pouvez de nouveau postuler aux offres.`,
          ``,
          `Tapez *MENU* pour continuer.`,
        ].join('\n'),
      ],
      clearState: true,
    };
  }

  // Default: show confirmation prompt
  return {
    reply: [
      [
        `💳 *Règlement de pénalités*`,
        ``,
        `Vous avez *${penaltyCount} pénalité(s) impayée(s)* pour un total de *${totalAmount.toLocaleString('fr-FR')} FCFA*.`,
        ``,
        `Pour régler, effectuez un virement Mobile Money au numéro indiqué par votre agent, puis confirmez ici.`,
        ``,
        `*1.* ✅ Confirmer le paiement`,
        `*2.* ↩️ Annuler`,
      ].join('\n'),
    ],
    nextState: state,
  };
}

export function getPayPenaltiesInitialState(
  penaltyCount: number,
  totalAmount: number,
): BotState {
  return {
    flowId: FLOW_IDS.PAY_PENALTIES,
    step: 1,
    payload: { penaltyCount, totalAmount },
    updatedAt: new Date().toISOString(),
  };
}
