import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import type { PaymentService } from '../../payments/payment.service';
import { PrismaService } from 'src/common/services/prisma/prisma.service';

export type VerifyWhatsappContext = {
  prisma: PrismaService;
  paymentService: PaymentService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runVerifyWhatsappFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: VerifyWhatsappContext,
): Promise<FlowResult> {
  const trimmed = input.trim();

  // Initial trigger — no input yet, prompt for code
  if (!trimmed) {
    return {
      reply: ['Veuillez entrer le code de vérification reçu par WhatsApp :'],
      nextState: {
        flowId: FLOW_IDS.VERIFY_WHATSAPP,
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // step 1 — await_code
  const now = new Date();

  const token = await ctx.prisma.verificationToken.findFirst({
    where: {
      profile_id: profile.id,
      token: trimmed,
    },
  });

  if (!token) {
    return {
      reply: ['❌ Code incorrect. Veuillez réessayer :'],
      nextState: state,
    };
  }

  if (token.expires_at < now) {
    return {
      reply: ['❌ Ce code a expiré. Contactez le support.'],
      clearState: true,
    };
  }

  if (token.used_at) {
    return {
      reply: ['❌ Ce code a déjà été utilisé. Contactez le support.'],
      clearState: true,
    };
  }

  // Valid token — mark used, generate payment link
  await ctx.prisma.verificationToken.update({
    where: { id: token.id },
    data: { used_at: now },
  });

  const paymentLink = await ctx.paymentService.generateActivationPaymentLink(
    profile.id,
  );

  return {
    reply: [
      `✅ Code vérifié !\n\nPour finaliser l'activation de votre compte Rabotka, veuillez effectuer le paiement d'activation via le lien suivant :\n\n${paymentLink}\n\nUne fois le paiement confirmé, votre compte sera activé automatiquement.`,
    ],
    clearState: true,
  };
}

export function getVerifyWhatsappInitialState(): BotState {
  return {
    flowId: FLOW_IDS.VERIFY_WHATSAPP,
    step: 1,
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}
