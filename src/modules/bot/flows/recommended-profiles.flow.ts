import {
  WalletTransactionType,
  PaymentType,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { generatePaymentReference } from '../../../common/utils/payment-reference';
import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import { formatContactUnlockedMessage } from '../messages/contact-unlock.messages';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { PaymentService } from '../../payments/payment.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';

export type RecommendedProfilesContext = {
  prisma: PrismaService;
  systemConfig: SystemConfigService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: PaymentService;
  botNotification: BotNotificationService;
  employerProfileId: string;
  interestSignalService: InterestSignalService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

function formatWorkerCard(
  index: number,
  w: {
    id: string;
    first_name: string;
    last_name: string;
    reliability_score: number | null;
    description: string | null;
  },
  aiScore: number,
): string {
  const name = `${w.first_name} ${w.last_name}`.trim();
  const score = w.reliability_score ?? 100;
  let desc = '';
  if (w.description) {
    const body =
      w.description.length > 80
        ? `${w.description.slice(0, 80)}…`
        : w.description;
    desc = `\n_${body}_`;
  }
  return `${index}. *${name}*\n   Fiabilité: ${score}/100 | IA: ${aiScore}%${desc}`;
}

function subMenu(): string {
  return [
    '',
    '1- Contacter le candidat',
    '2- Liste des candidats',
    '3- Menu',
  ].join('\n');
}

export async function runRecommendedProfilesFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const workerIds = (payload.workerIds as string[]) ?? [];
  const workerScores = (payload.workerScores as Record<string, number>) ?? {};
  const selectedWorkerId = payload.selectedWorkerId as string | undefined;
  const jobOfferId = payload.jobOfferId as string | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  if (workerIds.length === 0) {
    return {
      reply: [
        "*Aucun profil recommandé pour le moment. Tapez 'Menu' pour revenir.*",
      ],
      clearState: true,
    };
  }

  if (state.step === 2 && selectedWorkerId) {
    return handlePaymentStep(
      trimmed,
      selectedWorkerId,
      workerIds,
      workerScores,
      state,
      profile,
      ctx,
      jobOfferId,
    );
  }

  if (state.step === 1 && selectedWorkerId) {
    return handleDetailStep(trimmed, selectedWorkerId, {
      workerIds,
      workerScores,
      state,
      payload,
      profile,
      ctx,
      goToMenu,
      jobOfferId,
    });
  }

  if (trimmed === '7') return goToMenu();

  const pageWorkerIds = workerIds.slice(0, 5);
  const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;

  if (choice >= 1 && choice <= pageWorkerIds.length) {
    return showWorkerDetail(
      pageWorkerIds[choice - 1],
      workerIds,
      workerScores,
      state,
      ctx,
      jobOfferId,
    );
  }

  return showList(workerIds, workerScores, state, ctx);
}

async function handleDetailStep(
  trimmed: string,
  selectedWorkerId: string,
  opts: {
    workerIds: string[];
    workerScores: Record<string, number>;
    state: BotState;
    payload: Record<string, unknown>;
    profile: BotProfile;
    ctx: RecommendedProfilesContext;
    goToMenu: () => FlowResult;
    jobOfferId?: string;
  },
): Promise<FlowResult> {
  const { workerIds, workerScores, state, payload, profile, ctx, goToMenu, jobOfferId } =
    opts;
  if (trimmed === '3') return goToMenu();
  if (trimmed === '2') return showList(workerIds, workerScores, state, ctx);

  if (trimmed === '1') {
    const fee = await ctx.systemConfig.getRecommendationContactFee();
    const balance = await ctx.walletService.getProfileWalletBalance(profile.id);
    return showPaymentMethodPrompt({
      workerId: selectedWorkerId,
      fee,
      balance,
      workerIds,
      workerScores,
      state,
      jobOfferId,
    });
  }

  return {
    reply: [`Tapez *1*, *2* ou *3*.\n${subMenu()}`],
    nextState: {
      ...state,
      payload: { ...payload, workerIds, workerScores, selectedWorkerId, jobOfferId },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handlePaymentStep(
  trimmed: string,
  selectedWorkerId: string,
  workerIds: string[],
  workerScores: Record<string, number>,
  state: BotState,
  profile: BotProfile,
  ctx: RecommendedProfilesContext,
  jobOfferId?: string,
): Promise<FlowResult> {
  const fee = await ctx.systemConfig.getRecommendationContactFee();
  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);

  if (trimmed === '3') {
    return showWorkerDetail(
      selectedWorkerId,
      workerIds,
      workerScores,
      state,
      ctx,
      jobOfferId,
    );
  }

  if (trimmed === '1' && balance >= fee) {
    return processWalletPayment(selectedWorkerId, profile, fee, ctx);
  }

  if (trimmed === '2') {
    return generateMobileMoneyLink(
      selectedWorkerId,
      profile,
      fee,
      workerIds,
      workerScores,
      ctx,
    );
  }

  return showPaymentMethodPrompt({
    workerId: selectedWorkerId,
    fee,
    balance,
    workerIds,
    workerScores,
    state,
    jobOfferId,
  });
}

async function processWalletPayment(
  selectedWorkerId: string,
  profile: BotProfile,
  fee: number,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const worker = await ctx.prisma.profile.findUnique({
    where: { id: selectedWorkerId },
    select: { first_name: true, last_name: true, phone: true, email: true },
  });
  const workerName = worker
    ? `${worker.first_name} ${worker.last_name}`.trim()
    : 'ce candidat';

  try {
    const profileWallet = await ctx.walletService.getOrCreateProfileWallet(
      profile.id,
    );
    if (Number(profileWallet.balance) < fee) {
      throw new Error('Solde insuffisant dans votre portefeuille');
    }
    const txRef = generatePaymentReference();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.walletTransaction.create({
        data: {
          wallet_id: profileWallet.id,
          type: WalletTransactionType.CONTACT_UNLOCK_DEBIT,
          amount: fee,
          reference_type: 'recommendation_contact',
          reference_id: selectedWorkerId,
        },
      });
      await tx.wallet.update({
        where: { id: profileWallet.id },
        data: { balance: { decrement: fee } },
      });
      await tx.payment.create({
        data: {
          type: PaymentType.CONTACT_UNLOCK,
          profile_id: profile.id,
          amount: fee,
          payment_method: PaymentMethod.WALLET,
          transaction_id: txRef,
          status: PaymentStatus.COMPLETED,
          paid_at: new Date(),
          description: `Contact recommandé — ${workerName} [worker:${selectedWorkerId}]`,
        },
      });
    });
    return {
      reply: [
        formatContactUnlockedMessage({
          name: workerName,
          phone: worker?.phone ?? null,
          email: worker?.email ?? null,
        }),
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Erreur lors du paiement.';
    return { reply: [`❌ ${msg}`], clearState: true };
  }
}

async function showList(
  workerIds: string[],
  workerScores: Record<string, number>,
  state: BotState,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const pageWorkerIds = workerIds.slice(0, 5);
  const workers = await ctx.prisma.profile.findMany({
    where: { id: { in: pageWorkerIds } },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      reliability_score: true,
      description: true,
    },
  });

  const workerMap = new Map(workers.map((w) => [w.id, w]));
  const orderedWorkers = pageWorkerIds
    .map((id) => workerMap.get(id))
    .filter(Boolean) as typeof workers;

  const lines = [
    '*TRAVAILLEURS RECOMMANDÉS*',
    '',
    ...orderedWorkers.map((w, i) => {
      const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
      return formatWorkerCard(i + 1, w, aiScore);
    }),
    '',
    '*Tapez le numéro pour voir le profil complet ou 7 pour le menu.*',
  ];

  return {
    reply: [lines.join('\n')],
    nextState: {
      ...state,
      step: 0,
      payload: { workerIds, workerScores, jobOfferId: state.payload?.jobOfferId },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function showWorkerDetail(
  workerId: string,
  workerIds: string[],
  workerScores: Record<string, number>,
  state: BotState,
  ctx: RecommendedProfilesContext,
  jobOfferId?: string,
): Promise<FlowResult> {
  const worker = await ctx.prisma.profile.findUnique({
    where: { id: workerId },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      reliability_score: true,
      description: true,
      address: true,
      avatar_url: true,
    },
  });

  if (!worker) {
    return {
      reply: ['Profil introuvable. Tapez *7* pour le menu.'],
      nextState: state,
    };
  }

  // Record profile view signal on the worker for the linked job (fire-and-forget)
  if (jobOfferId) {
    void ctx.interestSignalService
      .record(workerId, jobOfferId, 'view')
      .catch(() => undefined);
  }

  const completedCount = await ctx.prisma.application.count({
    where: {
      worker_id: workerId,
      status: 'ACCEPTED',
      job_offer: { status: 'COMPLETED' },
    },
  });

  const name = `${worker.first_name} ${worker.last_name}`.trim();
  const aiScore = Math.round((workerScores[workerId] ?? 0) * 100);

  const detailLines = [
    `*${name}*`,
    `Score fiabilité: ${worker.reliability_score ?? 100}/100`,
    `Score IA: ${aiScore}%`,
    ...(worker.address ? [`Adresse: ${worker.address}`] : []),
    `Missions complétées: ${completedCount}`,
    ...(worker.description ? ['', `_${worker.description}_`] : []),
    subMenu(),
  ];

  const detailText = detailLines.join('\n');
  const reply = worker.avatar_url?.trim()
    ? [`[IMG:${worker.avatar_url}]${detailText}`]
    : [detailText];

  return {
    reply,
    nextState: {
      ...state,
      step: 1,
      payload: { workerIds, workerScores, selectedWorkerId: workerId, jobOfferId },
      updatedAt: new Date().toISOString(),
    },
  };
}

type PaymentPromptOpts = {
  workerId: string;
  fee: number;
  balance: number;
  workerIds: string[];
  workerScores: Record<string, number>;
  state: BotState;
  jobOfferId?: string;
};

function showPaymentMethodPrompt(opts: PaymentPromptOpts): FlowResult {
  const { workerId, fee, balance, workerIds, workerScores, state, jobOfferId } =
    opts;
  const hasFunds = balance >= fee;

  const walletLine = hasFunds
    ? `1- Utiliser mon crédit (${fee.toLocaleString('fr-FR')} FCFA)`
    : `1- Crédit portefeuille _(solde insuffisant — ${balance.toLocaleString('fr-FR')} FCFA)_`;

  const options = [walletLine, '2- Payer par mobile money', '3- Annuler'];

  const balanceLine = hasFunds
    ? `Solde disponible : *${balance.toLocaleString('fr-FR')} FCFA*`
    : `⚠️ Solde insuffisant (${balance.toLocaleString('fr-FR')} FCFA disponibles)`;

  const text = [
    `*Déverrouiller le contact*`,
    '',
    `Frais : *${fee.toLocaleString('fr-FR')} FCFA*`,
    balanceLine,
    '',
    '*Comment souhaitez-vous payer ?*',
    '',
    ...options,
  ].join('\n');

  return {
    reply: [text],
    nextState: {
      ...state,
      step: 2,
      payload: { workerIds, workerScores, selectedWorkerId: workerId, jobOfferId },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function generateMobileMoneyLink(
  workerId: string,
  profile: BotProfile,
  fee: number,
  workerIds: string[],
  workerScores: Record<string, number>,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const worker = await ctx.prisma.profile.findUnique({
    where: { id: workerId },
    select: { first_name: true, last_name: true },
  });
  const workerName = worker
    ? `${worker.first_name} ${worker.last_name}`.trim()
    : 'ce candidat';

  // Encode workerId in description so processSuccessfulPayment can reveal contacts via WhatsApp
  const paymentUrl = await ctx.paymentService.createPaymentUrl(
    profile.id,
    fee,
    `RECOMMENDATION_CONTACT:${workerId}`,
  );

  return {
    reply: [
      [
        `*Paiement par mobile money*`,
        '',
        `Pour voir les coordonnées de *${workerName}*, effectuez un paiement de *${fee.toLocaleString('fr-FR')} FCFA* via le lien ci-dessous :`,
        '',
        paymentUrl,
        '',
        '✅ Une fois le paiement confirmé, vous recevrez les coordonnées par WhatsApp.',
      ].join('\n'),
    ],
    clearState: true,
  };
}

export function getRecommendedProfilesInitialState(
  workerIds: string[],
  workerScores: Record<string, number> = {},
  jobOfferId?: string,
): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_PROFILES,
    step: 0,
    payload: { workerIds, workerScores, jobOfferId },
    updatedAt: new Date().toISOString(),
  };
}
