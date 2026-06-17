import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import type { PrismaService } from 'src/common/services/prisma/prisma.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import { AccountStatus, ProfileType } from '@prisma/client';
import { welcomeActivationMessage } from '../../whatsapp/templates';

export type VerifyWhatsappContext = {
  prisma: PrismaService;
  walletService: WalletService;
  systemConfigService: SystemConfigService;
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

  const MAX_OTP_ATTEMPTS = 5;
  const attempts = ((state.payload?.attempts as number) ?? 0) + 1;

  if (attempts > MAX_OTP_ATTEMPTS) {
    return {
      reply: ['❌ Trop de tentatives. Contactez le support pour obtenir un nouveau code.'],
      clearState: true,
    };
  }

  const now = new Date();

  const token = await ctx.prisma.verificationToken.findFirst({
    where: {
      profile_id: profile.id,
      token: trimmed,
    },
  });

  if (!token) {
    return {
      reply: [`❌ Code incorrect. Veuillez réessayer (${attempts}/${MAX_OTP_ATTEMPTS}) :`],
      nextState: { ...state, payload: { ...state.payload, attempts } },
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

  await ctx.prisma.$transaction([
    ctx.prisma.verificationToken.update({
      where: { id: token.id },
      data: { used_at: now },
    }),
    ctx.prisma.profile.update({
      where: { id: profile.id },
      data: { whatsapp_connected: true, status: AccountStatus.ACTIVE },
    }),
  ] as const);

  const profileType = profile.profile_type as ProfileType;
  const creditAmount = await ctx.walletService
    .grantWelcomeCredit(profile.id, profileType)
    .catch(() => 0);

  const wallet = await ctx.walletService
    .getOrCreateProfileWallet(profile.id)
    .catch(() => ({ balance: creditAmount }));

  const message = welcomeActivationMessage(
    profile.first_name,
    creditAmount,
    profile.profile_type,
    wallet.balance,
  );

  return {
    reply: [message],
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
