import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatContactUnlockPrompt,
  formatContactUnlockedMessage,
  formatContactUnlockPending,
} from '../messages/contact-unlock.messages';
import { PaymentRequestType } from '@prisma/client';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { IPaymentUrlService } from '../types/payment-url.types';
import type { BotNotificationService } from '../services/bot-notification.service';

export type UnlockContactContext = {
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: IPaymentUrlService;
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
  expiresAt: Date;
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
    expiresAt,
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
    return handleWalletCredit({
      profile,
      attemptId,
      otherName,
      expiresAt,
      ctx,
    });
  }

  const mobileMoneyOption = hasFunds ? '2' : '1';
  if (trimmed === mobileMoneyOption) {
    return handleMobileMoney({
      profile,
      otherName,
      amount,
      expiresAt,
      attemptId,
      ctx,
    });
  }

  const laterOption = hasFunds ? '3' : '2';
  if (trimmed === laterOption) {
    const deadline = expiresAt.toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return {
      reply: [
        `D'accord. Tapez *contact* quand vous êtes prêt(e) à débloquer ce contact.\n\nLa demande expire le *${deadline}*. Passé ce délai, si l'autre partie n'a pas payé, votre paiement sera recrédité sous forme de *crédit portefeuille*.`,
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
  otherName: string;
  expiresAt: Date;
  ctx: UnlockContactContext;
}): Promise<FlowResult> {
  const { profile, attemptId, otherName, expiresAt, ctx } = args;
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
        .sendContactUnlockedNotification(id, {
          skipNotifyProfileId: profile.id,
        })
        .catch((err) =>
          console.warn(`[unlock-contact] notification failed for ${id}:`, err),
        );
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
      reply: [
        formatContactUnlockPending({
          waitingFor,
          otherName,
          expiresAt,
        }),
      ],
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
  expiresAt: Date;
  attemptId: string;
  ctx: UnlockContactContext;
}): Promise<FlowResult> {
  const { profile, otherName, amount, expiresAt, attemptId, ctx } = args;
  const paymentUrl = await ctx.paymentService.createPaymentUrl(
    profile.id,
    amount,
    `Déverrouillage de contact — ${otherName}`,
    PaymentRequestType.CONTACT_UNLOCK,
    { contactUnlockAttemptId: attemptId },
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
        `✅ Une fois le paiement confirmé des deux côtés (vous et *${otherName}*), vous recevrez les coordonnées.`,
        '',
        `Si l'autre partie ne paie pas avant le *${new Date(expiresAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}*, votre paiement sera reversé vers votre wallet interne.`,
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
  const expiresAt = new Date((payload.expiresAt as string) ?? Date.now());

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
    expiresAt,
    ctx,
  };

  if (state.step === 1) return handleStep1(args);

  return goToMenu();
}

export function getUnlockContactInitialState(params: {
  attemptId: string;
  otherName: string;
  amount: number;
  expiresAt: Date | string;
}): BotState {
  return {
    flowId: FLOW_IDS.UNLOCK_CONTACT,
    step: 1,
    payload: {
      attemptId: params.attemptId,
      otherName: params.otherName,
      amount: params.amount,
      expiresAt: new Date(params.expiresAt).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
}
