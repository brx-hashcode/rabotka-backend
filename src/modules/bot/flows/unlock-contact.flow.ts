import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  formatContactUnlockPrompt,
  formatContactUnlockedMessage,
  formatContactUnlockPending,
} from '../messages/contact-unlock.messages';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';

export type UnlockContactContext = {
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runUnlockContactFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: UnlockContactContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: ['Tapez *MENU* pour revenir au menu principal.'],
    clearState: true,
  });

  if (CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))) {
    return goToMenu();
  }

  const payload = state.payload ?? {};
  const attemptId = payload.attemptId as string | undefined;
  const otherName = (payload.otherName as string) ?? 'votre contact';
  const amount = (payload.amount as number) ?? 0;

  if (!attemptId) {
    return {
      reply: ["*Erreur : tentative de déverrouillage introuvable. Tapez 'MENU'.*"],
      clearState: true,
    };
  }

  // Step 1: Show unlock prompt (or handle response)
  if (state.step === 1) {
    const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
    const hasFunds = balance >= amount;

    if (!trimmed) {
      // Initial display of prompt
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
      // Use credit
      try {
        const updated = await ctx.contactUnlockService.payUnlock(
          attemptId,
          profile.id,
          true,
        );
        if (updated.status === 'UNLOCKED') {
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

    // Mobile money payment (option 2 with funds, or option 1 without)
    const mobileMoneyOption = hasFunds ? '2' : '1';
    if (trimmed === mobileMoneyOption) {
      return {
        reply: [
          `📱 *Paiement par mobile money*\n\nEffectuez un transfert de *${amount} FCFA* au numéro indiqué par votre agent Rabotka, puis tapez *CONFIRMER* pour valider.`,
        ],
        nextState: {
          ...state,
          step: 2,
          payload: { ...payload, balance },
          updatedAt: new Date().toISOString(),
        },
      };
    }

    // Decide later (option 3 with funds, or option 2 without)
    const laterOption = hasFunds ? '3' : '2';
    if (trimmed === laterOption) {
      return {
        reply: [
          `D'accord. Tapez *DÉBLOQUER* quand vous êtes prêt(e) à débloquer ce contact.`,
        ],
        clearState: true,
      };
    }

    // Re-show prompt for unrecognized input
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

  // Step 2: Awaiting mobile money confirmation
  if (state.step === 2) {
    if (normalized === 'confirmer') {
      return {
        reply: [
          `✅ Votre confirmation a été reçue.\n\nNous allons vérifier votre paiement et débloquer le contact dès validation. Vous serez notifié(e) automatiquement.`,
        ],
        clearState: true,
      };
    }

    if (normalized === 'annuler' || normalized === '0') {
      return goToMenu();
    }

    return {
      reply: [
        `Tapez *CONFIRMER* une fois le paiement effectué, ou *ANNULER* pour revenir.`,
      ],
      nextState: state,
    };
  }

  return goToMenu();
}

export function getUnlockContactInitialState(params: {
  attemptId: string;
  otherName: string;
  amount: number;
}): BotState {
  return {
    flowId: FLOW_IDS.UNLOCK_CONTACT,
    step: 1,
    payload: {
      attemptId: params.attemptId,
      otherName: params.otherName,
      amount: params.amount,
    },
    updatedAt: new Date().toISOString(),
  };
}
