import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatContactUnlockPrompt,
  formatContactUnlockedMessage,
  formatContactUnlockPending,
} from '../messages/contact-unlock.messages';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { PaymentService } from '../../payments/payment.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type UnlockContactContext = {
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: PaymentService;
  botNotification: BotNotificationService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type StepArgs = {
  state: BotState;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  payload: Record<string, unknown>;
  attemptId: string;
  otherName: string;
  amount: number;
  expiryHours: number;
  ctx: UnlockContactContext;
};

const goToMenu = (): FlowResult => ({
  reply: ['Tapez *MENU* pour revenir au menu principal.'],
  clearState: true,
});

async function handleStep1(args: StepArgs): Promise<FlowResult> {
  const {
    state,
    trimmed,
    profile,
    payload,
    attemptId,
    otherName,
    amount,
    expiryHours,
    ctx,
  } = args;

  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
  const hasFunds = balance >= amount;

  if (!trimmed) {
    return {
      reply: [
        formatContactUnlockPrompt({
          name: otherName,
          amount,
          balance,
          profileType: profile.profile_type,
        }),
      ],
      nextState: {
        ...state,
        payload: { ...payload, balance },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (hasFunds && trimmed === '1') {
    return handleWalletCredit({ profile, attemptId, ctx });
  }

  const mobileMoneyOption = hasFunds ? '2' : '1';
  if (trimmed === mobileMoneyOption) {
    return handleMobileMoney({
      profile,
      otherName,
      amount,
      attemptId,
      ctx,
    });
  }

  const laterOption = hasFunds ? '3' : '2';
  if (trimmed === laterOption) {
    return {
      reply: [
        `D'accord. Tapez *contact* quand vous êtes prêt(e) à débloquer ce contact.\n\n⚠️ La demande expire dans *${expiryHours}h*. Passé ce délai, si l'autre partie n'a pas payé, votre paiement sera recrédité sous forme de *crédit portefeuille*.`,
      ],
      clearState: true,
    };
  }

  return {
    reply: [
      formatContactUnlockPrompt({
        name: otherName,
        amount,
        balance,
        profileType: profile.profile_type,
      }),
    ],
    nextState: state,
  };
}

async function handleWalletCredit(args: {
  profile: BotProfile;
  attemptId: string;
  ctx: UnlockContactContext;
}): Promise<FlowResult> {
  const { profile, attemptId, ctx } = args;
  try {
    const result = await ctx.contactUnlockService.payUnlock(
      attemptId,
      profile.id,
      true,
    );

    const unlockedIds =
      result.status === 'UNLOCKED'
        ? [...new Set([result.attemptId, ...result.newlyUnlocked])]
        : result.newlyUnlocked;

    for (const id of unlockedIds) {
      await ctx.botNotification
        .sendContactUnlockedNotification(id)
        .catch(() => null);
    }

    if (result.status === 'UNLOCKED') {
      const contacts = await ctx.contactUnlockService.getContactsIfUnlocked(
        attemptId,
        profile.id,
      );
      if (contacts) {
        return {
          reply: [formatContactUnlockedMessage(contacts)],
          clearState: true,
        };
      }
    }

    const waitingFor =
      profile.profile_type === 'EMPLOYER' ? 'worker' : 'employer';
    return {
      reply: [formatContactUnlockPending(waitingFor)],
      clearState: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur lors du paiement.';
    return { reply: [`❌ ${msg}`], clearState: true };
  }
}

async function handleMobileMoney(args: {
  profile: BotProfile;
  otherName: string;
  amount: number;
  attemptId: string;
  ctx: UnlockContactContext;
}): Promise<FlowResult> {
  const { profile, otherName, amount, attemptId, ctx } = args;
  const paymentUrl = await ctx.paymentService.createPaymentUrl(
    profile.id,
    amount,
    'Déverrouillage de contact',
    attemptId,
  );
  return {
    reply: [
      [
        `*PAIEMENT PAR MOBILE MONEY*`,
        ``,
        `Pour débloquer le contact de *${otherName}*, effectuez un paiement de *${amount} FCFA* via le lien ci-dessous :`,
        ``,
        paymentUrl,
        ``,
        `✅ Une fois le paiement confirmé, vous recevrez automatiquement les coordonnées de contact.`,
      ].join('\n'),
    ],
    clearState: true,
  };
}

export async function runUnlockContactFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: UnlockContactContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  const payload = state.payload ?? {};
  const attemptId = payload.attemptId as string | undefined;
  const otherName = (payload.otherName as string) ?? 'votre contact';
  const amount = (payload.amount as number) ?? 0;
  const expiryHours = (payload.expiryHours as number) ?? 48;

  if (!attemptId) {
    return {
      reply: [
        "*Erreur : tentative de déverrouillage introuvable. Tapez 'MENU'.*",
      ],
      clearState: true,
    };
  }

  const args: StepArgs = {
    state,
    trimmed,
    normalized,
    profile,
    payload,
    attemptId,
    otherName,
    amount,
    expiryHours,
    ctx,
  };

  if (state.step === 1) return handleStep1(args);

  return goToMenu();
}

export function getUnlockContactInitialState(params: {
  attemptId: string;
  otherName: string;
  amount: number;
  expiryHours?: number;
}): BotState {
  return {
    flowId: FLOW_IDS.UNLOCK_CONTACT,
    step: 1,
    payload: {
      attemptId: params.attemptId,
      otherName: params.otherName,
      amount: params.amount,
      expiryHours: params.expiryHours ?? 48,
    },
    updatedAt: new Date().toISOString(),
  };
}
