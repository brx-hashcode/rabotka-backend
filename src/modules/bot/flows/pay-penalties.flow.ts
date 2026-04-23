import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { PaymentService } from '../../payments/payment.service';
import { WalletTransactionType } from '@prisma/client';

export type PayPenaltiesContext = {
  applicationService: ApplicationService;
  walletService: WalletService;
  paymentService: PaymentService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

function isMenuCommand(normalizedInput: string): boolean {
  return (
    normalizedInput === 'retour' ||
    CMD_MENU.some(
      (command) =>
        normalizedInput === command ||
        normalizedInput.startsWith(command + ' '),
    )
  );
}

function createWalletStepState(
  state: BotState,
  penaltyCount: number,
  totalAmount: number,
): BotState {
  return {
    ...state,
    step: 2,
    payload: { penaltyCount, totalAmount },
    updatedAt: new Date().toISOString(),
  };
}

function buildInsufficientFundsReply(
  balance: number,
  totalAmount: number,
): string {
  return [
    `⚠️ *Solde insuffisant*`,
    ``,
    `Votre solde est de *${balance.toLocaleString('fr-FR')} FCFA*, mais le montant dû est de *${totalAmount.toLocaleString('fr-FR')} FCFA*.`,
    ``,
    `Tapez *MENU* pour revenir ou effectuez un rechargement d'abord.`,
  ].join('\n');
}

function buildWalletPaymentSuccessReply(
  paidCount: number,
  totalAmount: number,
): string {
  return [
    `🎉 *Paiement par crédit enregistré*`,
    ``,
    `*${paidCount} pénalité(s)* (${totalAmount.toLocaleString('fr-FR')} FCFA) ont été réglées depuis votre portefeuille.`,
    ``,
    `Votre compte est maintenant *débloqué*.`,
    ``,
    `Tapez *MENU* pour continuer.`,
  ].join('\n');
}

async function handleWalletConfirmationStep(
  state: BotState,
  trimmedInput: string,
  normalizedInput: string,
  profile: BotProfile,
  ctx: PayPenaltiesContext,
  totalAmount: number,
  goToMenu: () => FlowResult,
): Promise<FlowResult> {
  if (trimmedInput === '2' || normalizedInput === 'annuler') return goToMenu();

  if (!(trimmedInput === '1' || normalizedInput === 'oui')) {
    return {
      reply: ['*Répondez par 1 (confirmer) ou 2 (annuler).*'],
      nextState: state,
    };
  }

  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
  if (balance < totalAmount) {
    return {
      reply: [buildInsufficientFundsReply(balance, totalAmount)],
      clearState: true,
    };
  }

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
      buildWalletPaymentSuccessReply(result.paidCount, result.totalAmount),
    ],
    clearState: true,
  };
}

async function handleMobileMoneyOption(
  profile: BotProfile,
  ctx: PayPenaltiesContext,
  totalAmount: number,
  penaltyCount: number,
): Promise<FlowResult> {
  const description = `PENALTY_BATCH:${profile.id}`;
  const paymentUrl = await ctx.paymentService.createPaymentUrl(
    profile.id,
    totalAmount,
    description,
  );

  return {
    reply: [
      [
        `*Paiement Mobile Money*`,
        ``,
        `Effectuez un paiement de *${totalAmount.toLocaleString('fr-FR')} FCFA* via le lien ci-dessous :`,
        ``,
        paymentUrl,
        ``,
        `Votre compte sera automatiquement débloqué dès réception du paiement.`,
        ``,
        `Tapez *MENU* pour revenir au menu principal.`,
      ].join('\n'),
    ],
    clearState: true,
  };
}

async function handleWalletOption(
  state: BotState,
  profile: BotProfile,
  ctx: PayPenaltiesContext,
  totalAmount: number,
  penaltyCount: number,
): Promise<FlowResult> {
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
          ? `1- Confirmer le débit de ${totalAmount.toLocaleString('fr-FR')} FCFA`
          : `⚠️ Solde insuffisant — rechargez votre portefeuille d'abord.`,
        `2- Annuler`,
      ].join('\n'),
    ],
    nextState: hasFunds
      ? createWalletStepState(state, penaltyCount, totalAmount)
      : state,
  };
}

async function buildMainPaymentPrompt(
  state: BotState,
  profile: BotProfile,
  ctx: PayPenaltiesContext,
  penaltyCount: number,
  totalAmount: number,
): Promise<FlowResult> {
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
        `1- Mobile Money (lien de paiement sécurisé)`,
        canUseWallet
          ? `2- Utiliser mon crédit portefeuille (${balance.toLocaleString('fr-FR')} FCFA disponibles)`
          : `2- Portefeuille *(solde insuffisant : ${balance.toLocaleString('fr-FR')} FCFA)*`,
        `3- Annuler`,
      ].join('\n'),
    ],
    nextState: state,
  };
}

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

  if (isMenuCommand(normalized)) {
    return goToMenu();
  }

  const payload = state.payload ?? {};
  const totalAmount = payload.totalAmount as number;
  const penaltyCount = payload.penaltyCount as number;

  if (state.step === 2) {
    return handleWalletConfirmationStep(
      state,
      trimmed,
      normalized,
      profile,
      ctx,
      totalAmount,
      goToMenu,
    );
  }

  if (trimmed === '1') {
    return handleMobileMoneyOption(profile, ctx, totalAmount, penaltyCount);
  }

  if (trimmed === '2') {
    return handleWalletOption(state, profile, ctx, totalAmount, penaltyCount);
  }

  if (trimmed === '3' || normalized === 'annuler') return goToMenu();
  return buildMainPaymentPrompt(state, profile, ctx, penaltyCount, totalAmount);
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
