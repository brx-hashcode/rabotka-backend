import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { ApplicationService } from '../../application/application.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { InvoiceService } from '../../invoice/invoice.service';
import type { IPaymentUrlService } from '../types/payment-url.types';
import {
  WalletTransactionType,
  PaymentRequestType,
  PaymentType,
  PaymentMethod,
  PaymentStatus,
  PaymentRequestStatus,
  InvoiceReason,
} from '@prisma/client';
import { generatePaymentReference } from '../../../common/utils/payment-reference';
import { randomUUID } from 'crypto';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  getMobileMoneyInitialPayload,
  runMobileMoneySubFlow,
} from '../utils/mobile-money-subflow';

export type PayPenaltiesContext = {
  applicationService: ApplicationService;
  walletService: WalletService;
  paymentService: IPaymentUrlService;
  invoiceService: InvoiceService;
  prisma: PrismaService;
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

  // Fetch penalty IDs before marking paid so we can link them to the invoice
  const unpaid = await ctx.applicationService.getUnpaidPenalties(profile.id);

  // Mark penalties paid before touching the wallet — if the debit fails the
  // user retries and we re-check balance, but at least no money is lost.
  const result = await ctx.applicationService.markPenaltiesPaid(profile.id);

  // Atomic debit of profile wallet + credit of system wallet in one transaction
  await ctx.walletService.debitProfileAndCreditSystem(
    profile.id,
    totalAmount,
    WalletTransactionType.PENALTY_DEBIT,
    WalletTransactionType.CREDIT_PENALTY,
    'penalty_batch',
    profile.id,
  );

  // Create Payment record and issue invoice
  const reference = generatePaymentReference();
  const token = randomUUID();

  const paymentRequest = await ctx.prisma.paymentRequest.create({
    data: {
      profile_id: profile.id,
      token,
      status: PaymentRequestStatus.APPROVED,
      amount: totalAmount,
      description: `Paiement de ${result.paidCount} pénalité(s) (wallet interne)`,
      payment_reference: reference,
    },
  });

  await ctx.prisma.payment.create({
    data: {
      type: PaymentType.PENALTY,
      profile_id: profile.id,
      amount: totalAmount,
      payment_method: PaymentMethod.WALLET,
      transaction_id: reference,
      status: PaymentStatus.COMPLETED,
      paid_at: new Date(),
      description: `Paiement de ${result.paidCount} pénalité(s) via wallet`,
    },
  });

  await ctx.invoiceService.create({
    profileId: profile.id,
    paymentRequestId: paymentRequest.id,
    amount: totalAmount,
    reason: InvoiceReason.PENALTY,
    relatedEntityType: 'penalty_batch',
    relatedEntityId: unpaid.ids[0] ?? profile.id,
  });

  return {
    reply: [
      buildWalletPaymentSuccessReply(result.paidCount, result.totalAmount),
    ],
    clearState: true,
  };
}

async function enterMobileMoneySubFlow(
  state: BotState,
  profile: BotProfile,
  ctx: PayPenaltiesContext,
  totalAmount: number,
  penaltyCount: number,
): Promise<FlowResult> {
  const description = `Paiement de pénalités (${penaltyCount} pénalité(s))`;
  const mmPayload = getMobileMoneyInitialPayload({
    amount: totalAmount,
    description,
    requestType: PaymentRequestType.PENALTY_BATCH,
  });
  const nextState: BotState = {
    ...state,
    payload: { ...state.payload, ...mmPayload },
    updatedAt: new Date().toISOString(),
  };
  return runMobileMoneySubFlow(nextState, '', profile, {
    paymentService: ctx.paymentService,
    getFallbackUrl: () =>
      ctx.paymentService.createPaymentUrl(
        profile.id,
        totalAmount,
        description,
        PaymentRequestType.PENALTY_BATCH,
      ),
  });
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
        `*Paiement par crédit portefeuille*`,
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
        `*Règlement de pénalités*`,
        ``,
        `Vous avez *${penaltyCount} pénalité(s) impayée(s)* pour un total de *${totalAmount.toLocaleString('fr-FR')} FCFA*.`,
        ``,
        `*Comment souhaitez-vous régler ?*`,
        ``,
        `1- Mobile Money`,
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

  // In mobile money sub-flow (step stays at 1; _mm_step drives sub-flow navigation)
  if (payload._mm_step) {
    return runMobileMoneySubFlow(state, input, profile, {
      paymentService: ctx.paymentService,
      getFallbackUrl: () =>
        ctx.paymentService.createPaymentUrl(
          profile.id,
          totalAmount,
          `Paiement de pénalités (${penaltyCount} pénalité(s))`,
          PaymentRequestType.PENALTY_BATCH,
        ),
    });
  }

  if (trimmed === '1') {
    return enterMobileMoneySubFlow(
      state,
      profile,
      ctx,
      totalAmount,
      penaltyCount,
    );
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
