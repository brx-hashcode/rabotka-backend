import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';
import type { WalletService } from '../../wallet/wallet.service';
import { WalletTransactionType } from '@prisma/client';

export type PayPenaltiesContext = {
  applicationService: ApplicationService;
  walletService: WalletService;
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
    normalized === 'retour'
  ) {
    return goToMenu();
  }

  const payload = state.payload ?? {};
  const totalAmount = payload.totalAmount as number;
  const penaltyCount = payload.penaltyCount as number;

  // --- Step 2: wallet credit confirmation ---
  if (state.step === 2) {
    if (trimmed === '2' || normalized === 'annuler') return goToMenu();

    if (trimmed === '1' || normalized === 'oui') {
      const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
      if (balance < totalAmount) {
        return {
          reply: [
            [
              `⚠️ *Solde insuffisant*`,
              ``,
              `Votre solde est de *${balance.toLocaleString('fr-FR')} FCFA*, mais le montant dû est de *${totalAmount.toLocaleString('fr-FR')} FCFA*.`,
              ``,
              `Tapez *MENU* pour revenir ou effectuez un rechargement mobile money d'abord.`,
            ].join('\n'),
          ],
          clearState: true,
        };
      }

      // Debit wallet and mark penalties paid
      await ctx.walletService.debitProfileWallet(
        profile.id,
        totalAmount,
        WalletTransactionType.PENALTY_DEBIT,
        'penalty_batch',
        profile.id,
      );
      const result = await ctx.applicationService.markPenaltiesPaid(profile.id);

      return {
        reply: [
          [
            `✅ *Paiement par crédit enregistré*`,
            ``,
            `*${result.paidCount} pénalité(s)* (${result.totalAmount.toLocaleString('fr-FR')} FCFA) ont été réglées depuis votre portefeuille.`,
            ``,
            `Votre compte est maintenant *débloqué*.`,
            ``,
            `Tapez *MENU* pour continuer.`,
          ].join('\n'),
        ],
        clearState: true,
      };
    }

    return {
      reply: ['*Répondez par 1 (confirmer) ou 2 (annuler).*'],
      nextState: state,
    };
  }

  // --- Step 1: choose payment method ---
  if (trimmed === '1') {
    // Mobile money — confirm with external payment
    const result = await ctx.applicationService.markPenaltiesPaid(profile.id);
    if (result.paidCount === 0) {
      return {
        reply: [`✅ *Aucune pénalité en attente.*\n\nVotre compte est en règle. Tapez *MENU* pour continuer.`],
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

  if (trimmed === '2') {
    // Wallet credit — ask for confirmation
    const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
    const hasFunds = balance >= totalAmount;

    return {
      reply: [
        [
          `💳 *Paiement par crédit portefeuille*`,
          ``,
          `Montant dû : *${totalAmount.toLocaleString('fr-FR')} FCFA*`,
          `Solde disponible : *${balance.toLocaleString('fr-FR')} FCFA*`,
          ``,
          hasFunds
            ? `1️⃣ Confirmer le débit de ${totalAmount.toLocaleString('fr-FR')} FCFA`
            : `⚠️ Solde insuffisant — rechargez votre portefeuille d'abord.`,
          `2️⃣ Annuler`,
        ].join('\n'),
      ],
      nextState: hasFunds
        ? {
            ...state,
            step: 2,
            payload: { penaltyCount, totalAmount },
            updatedAt: new Date().toISOString(),
          }
        : state,
    };
  }

  if (trimmed === '3' || normalized === 'annuler') return goToMenu();

  // Default: show payment options
  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
  const canUseWallet = balance >= totalAmount;

  return {
    reply: [
      [
        `💳 *Règlement de pénalités*`,
        ``,
        `Vous avez *${penaltyCount} pénalité(s) impayée(s)* pour un total de *${totalAmount.toLocaleString('fr-FR')} FCFA*.`,
        ``,
        `*Comment souhaitez-vous régler ?*`,
        ``,
        `1️⃣ Mobile Money (confirmer après virement)`,
        canUseWallet
          ? `2️⃣ Utiliser mon crédit portefeuille (${balance.toLocaleString('fr-FR')} FCFA disponibles)`
          : `2️⃣ Portefeuille *(solde insuffisant : ${balance.toLocaleString('fr-FR')} FCFA)*`,
        `3️⃣ Annuler`,
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
