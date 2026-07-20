import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import { walletRechargeReply } from '../../../common/constants/whatsapp-listpickers';
import type { WalletService } from '../../wallet/wallet.service';
import type { IPaymentUrlService } from '../types/payment-url.types';
import { PaymentRequestType } from '@prisma/client';
import {
  getMobileMoneyInitialPayload,
  runMobileMoneySubFlow,
} from '../utils/mobile-money-subflow';

export type CreditWalletContext = {
  paymentService: IPaymentUrlService;
  walletService: WalletService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PRESET_AMOUNTS = [1_000, 2_500, 5_000, 10_000] as const;
const MIN_AMOUNT = 500;
const MAX_AMOUNT = 500_000;

function isMenuCommand(normalized: string): boolean {
  return (
    normalized === 'retour' ||
    CMD_MENU.some(
      (command) =>
        normalized === command || normalized.startsWith(command + ' '),
    )
  );
}

/**
 * The amount step is a WhatsApp list-picker: a "Choisir un montant" button that
 * opens a tap-list of the presets, "Montant personnalisé" (id 5) and "Annuler"
 * (id 0). A tapped row returns its id, which handleAmountSelection parses just
 * like the typed digit — so typing still works.
 *
 * The rows are baked into the Content template, so PRESET_AMOUNTS below must
 * stay in sync with it (see scripts/create_listpickers.py).
 */
function buildAmountMenuMessage(balance: number): string {
  return walletRechargeReply(balance.toLocaleString('fr-FR'));
}

async function handleAmountSelection(
  state: BotState,
  trimmed: string,
  normalized: string,
  profile: BotProfile,
  ctx: CreditWalletContext,
): Promise<FlowResult> {
  if (trimmed === '0' || normalized === 'annuler') {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  // Preset amounts
  const presetIndex = Number.parseInt(trimmed, 10) - 1;
  if (presetIndex >= 0 && presetIndex < PRESET_AMOUNTS.length) {
    const amount = PRESET_AMOUNTS[presetIndex];
    return enterMobileMoneySubFlow(state, profile, ctx, amount);
  }

  // Custom amount
  if (trimmed === '5') {
    return {
      reply: [
        [
          `*Montant personnalisé*`,
          ``,
          `Entrez le montant à recharger (entre ${MIN_AMOUNT.toLocaleString('fr-FR')} et ${MAX_AMOUNT.toLocaleString('fr-FR')} FCFA) :`,
        ].join('\n'),
      ],
      nextState: {
        ...state,
        step: 2,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // Unrecognized — redisplay menu
  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
  return {
    reply: [buildAmountMenuMessage(balance)],
    nextState: state,
  };
}

function handleCustomAmountInput(
  trimmed: string,
  normalized: string,
  profile: BotProfile,
  ctx: CreditWalletContext,
  state: BotState,
): Promise<FlowResult> {
  if (trimmed === '0' || normalized === 'annuler') {
    return Promise.resolve({
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    });
  }

  const amount = Number.parseFloat(
    trimmed.replace(/\s/g, '').replace(',', '.'),
  );

  if (Number.isNaN(amount) || !Number.isFinite(amount)) {
    return Promise.resolve({
      reply: [
        `❌ Montant invalide. Veuillez entrer un nombre entier (ex: *3000*) ou tapez *0* pour annuler.`,
      ],
      nextState: state,
    });
  }

  if (amount < MIN_AMOUNT) {
    return Promise.resolve({
      reply: [
        `❌ Le montant minimum est de *${MIN_AMOUNT.toLocaleString('fr-FR')} FCFA*. Veuillez entrer un montant plus élevé ou tapez *0* pour annuler.`,
      ],
      nextState: state,
    });
  }

  if (amount > MAX_AMOUNT) {
    return Promise.resolve({
      reply: [
        `❌ Le montant maximum est de *${MAX_AMOUNT.toLocaleString('fr-FR')} FCFA*. Veuillez entrer un montant moins élevé ou tapez *0* pour annuler.`,
      ],
      nextState: state,
    });
  }

  return enterMobileMoneySubFlow(state, profile, ctx, Math.floor(amount));
}

async function enterMobileMoneySubFlow(
  state: BotState,
  profile: BotProfile,
  ctx: CreditWalletContext,
  amount: number,
): Promise<FlowResult> {
  const description = `Recharge du wallet — ${amount.toLocaleString('fr-FR')} FCFA`;
  const mmPayload = getMobileMoneyInitialPayload({
    amount,
    description,
    requestType: PaymentRequestType.WALLET_TOP_UP,
  });
  const nextState: BotState = {
    ...state,
    step: 1,
    payload: { amount, ...mmPayload },
    updatedAt: new Date().toISOString(),
  };
  return runMobileMoneySubFlow(nextState, '', profile, {
    paymentService: ctx.paymentService,
    getFallbackUrl: () =>
      ctx.paymentService.createPaymentUrl(
        profile.id,
        amount,
        description,
        PaymentRequestType.WALLET_TOP_UP,
      ),
  });
}

export async function runCreditWalletFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: CreditWalletContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (isMenuCommand(normalized)) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  const payload = state.payload ?? {};

  // Mobile money sub-flow active (step 1 with _mm_step)
  if (payload._mm_step) {
    const amount = payload.amount as number;
    const description = `Recharge du wallet — ${amount.toLocaleString('fr-FR')} FCFA`;
    return runMobileMoneySubFlow(state, input, profile, {
      paymentService: ctx.paymentService,
      getFallbackUrl: () =>
        ctx.paymentService.createPaymentUrl(
          profile.id,
          amount,
          description,
          PaymentRequestType.WALLET_TOP_UP,
        ),
    });
  }

  // Step 2: custom amount entry
  if (state.step === 2) {
    return handleCustomAmountInput(trimmed, normalized, profile, ctx, state);
  }

  // Step 1: amount selection menu
  return handleAmountSelection(state, trimmed, normalized, profile, ctx);
}

export async function getCreditWalletInitialState(
  profile: BotProfile,
  ctx: CreditWalletContext,
): Promise<{ state: BotState; message: string }> {
  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
  const state: BotState = {
    flowId: FLOW_IDS.CREDIT_WALLET,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
  return { state, message: buildAmountMenuMessage(balance) };
}
