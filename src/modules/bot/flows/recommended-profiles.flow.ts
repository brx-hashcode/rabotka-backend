import {
  WalletTransactionType,
  PaymentType,
  PaymentMethod,
  PaymentStatus,
  PaymentRequestType,
  InvoiceReason,
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
import type { IPaymentUrlService } from '../types/payment-url.types';
import {
  getMobileMoneyInitialPayload,
  runMobileMoneySubFlow,
} from '../utils/mobile-money-subflow';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';
import type { InvoiceService } from '../../invoice/invoice.service';

export type RecommendedProfilesContext = {
  prisma: PrismaService;
  systemConfig: SystemConfigService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: IPaymentUrlService;
  botNotification: BotNotificationService;
  employerProfileId: string;
  interestSignalService: InterestSignalService;
  invoiceService: InvoiceService;
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
        '*Aucun profil recommandé pour le moment. Tapez *Menu* pour revenir.*',
      ],
      clearState: true,
    };
  }

  // In mobile money sub-flow
  if (payload._mm_step) {
    const fee = (payload._mm_amount as number) ?? 0;
    const workerId = payload._mm_worker_id as string;
    return runMobileMoneySubFlow(state, input, profile, {
      paymentService: ctx.paymentService,
      getFallbackUrl: () =>
        ctx.paymentService.createPaymentUrl(
          profile.id,
          fee,
          (payload._mm_description as string) ??
            'Déverrouillage contact recommandé',
          PaymentRequestType.RECOMMENDATION_CONTACT,
          { recommendationWorkerId: workerId },
        ),
    });
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

  // Use renderedWorkerIds when available (set by showList) so selection always
  // maps to the displayed position, even if some IDs were not found in the DB.
  const renderedWorkerIds =
    (payload.renderedWorkerIds as string[] | undefined) ??
    workerIds.slice(0, 5);
  const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;

  if (choice >= 1 && choice <= renderedWorkerIds.length) {
    return showWorkerDetail(
      renderedWorkerIds[choice - 1],
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
  const {
    workerIds,
    workerScores,
    state,
    payload,
    profile,
    ctx,
    goToMenu,
    jobOfferId,
  } = opts;
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
      payload: {
        ...payload,
        workerIds,
        workerScores,
        selectedWorkerId,
        jobOfferId,
      },
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

  if (trimmed === '1') {
    if (balance < fee) {
      return {
        reply: [
          `⚠️ *Solde insuffisant*\n\nVotre solde est de *${balance.toLocaleString('fr-FR')} FCFA* pour un frais de *${fee.toLocaleString('fr-FR')} FCFA*.\n\nChoisissez *2* pour payer par Mobile Money ou *3* pour annuler.`,
        ],
        nextState: state,
      };
    }
    return processWalletPayment(selectedWorkerId, profile, fee, ctx);
  }

  if (trimmed === '2') {
    return enterMobileMoneySubFlow(
      selectedWorkerId,
      profile,
      fee,
      workerIds,
      workerScores,
      state,
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
  const worker = await ctx.prisma.profile.findFirst({
    where: {
      id: selectedWorkerId,
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
    },
    select: { first_name: true, last_name: true, phone: true, email: true },
  });

  if (!worker) {
    return {
      reply: [
        "*Ce profil n'est plus actif ou vérifié. Le paiement n'a pas été effectué.*",
      ],
      clearState: true,
    };
  }

  const workerName = `${worker.first_name} ${worker.last_name}`.trim();

  try {
    const profileWallet = await ctx.walletService.getOrCreateProfileWallet(
      profile.id,
    );
    if (Number(profileWallet.balance) < fee) {
      throw new Error('Solde insuffisant dans votre portefeuille');
    }
    const txRef = generatePaymentReference();
    const systemWallet = await ctx.walletService.getOrCreateSystemWallet();
    let paymentId: string | undefined;
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
      await tx.walletTransaction.create({
        data: {
          wallet_id: systemWallet.id,
          type: WalletTransactionType.CONTACT_UNLOCK_PAYMENT,
          amount: fee,
          reference_type: 'recommendation_contact',
          reference_id: selectedWorkerId,
        },
      });
      await tx.wallet.update({
        where: { id: systemWallet.id },
        data: { balance: { increment: fee } },
      });
      const payment = await tx.payment.create({
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
      paymentId = payment.id;
    });

    // Create invoice for wallet payment (fire-and-forget, non-blocking)
    if (paymentId) {
      void ctx.invoiceService
        .create({
          profileId: profile.id,
          paymentId,
          amount: fee,
          reason: InvoiceReason.CONTACT_UNLOCK,
          relatedEntityType: 'worker',
          relatedEntityId: selectedWorkerId,
        })
        .catch(() => undefined);
    }

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
    where: {
      id: { in: pageWorkerIds },
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
    },
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
    '*travailleurs recommandés*',
    '',
    ...orderedWorkers.map((w, i) => {
      const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
      return formatWorkerCard(i + 1, w, aiScore);
    }),
    '',
    '*Tapez le numéro pour voir le profil complet ou 7 pour le menu.*',
  ];

  // Store the rendered order explicitly so selection always maps to the displayed item
  const renderedWorkerIds = orderedWorkers.map((w) => w.id);

  return {
    reply: [lines.join('\n')],
    nextState: {
      ...state,
      step: 0,
      payload: {
        workerIds,
        renderedWorkerIds,
        workerScores,
        jobOfferId: state.payload?.jobOfferId,
      },
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
  const worker = await ctx.prisma.profile.findFirst({
    where: {
      id: workerId,
      status: 'ACTIVE',
      verification_status: 'VERIFIED',
    },
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
      reply: ["*Ce profil n'est plus disponible. Tapez *7* pour revenir.*"],
      nextState: {
        ...state,
        step: 0,
        payload: { workerIds, workerScores, jobOfferId },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // Record profile_view signal on the employer — they are the one browsing worker profiles.
  // This populates the employer's interest graph so future recommendations improve.
  if (jobOfferId) {
    void ctx.interestSignalService
      .record(ctx.employerProfileId, jobOfferId, 'profile_view')
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
      payload: {
        workerIds,
        workerScores,
        selectedWorkerId: workerId,
        jobOfferId,
      },
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
      payload: {
        workerIds,
        workerScores,
        selectedWorkerId: workerId,
        jobOfferId,
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function enterMobileMoneySubFlow(
  workerId: string,
  profile: BotProfile,
  fee: number,
  workerIds: string[],
  workerScores: Record<string, number>,
  state: BotState,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const worker = await ctx.prisma.profile.findFirst({
    where: { id: workerId, status: 'ACTIVE', verification_status: 'VERIFIED' },
    select: { first_name: true, last_name: true },
  });
  if (!worker) {
    return {
      reply: [
        "*Ce profil n'est plus actif ou vérifié. Le paiement n'a pas été effectué.*",
      ],
      clearState: true,
    };
  }
  const workerName = `${worker.first_name} ${worker.last_name}`.trim();
  const description = `Déverrouillage contact recommandé — ${workerName}`;

  const mmPayload = getMobileMoneyInitialPayload({
    amount: fee,
    description,
    requestType: PaymentRequestType.RECOMMENDATION_CONTACT,
    options: { recommendationWorkerId: workerId },
  });
  const nextState: BotState = {
    ...state,
    payload: {
      workerIds,
      workerScores,
      selectedWorkerId: workerId,
      _mm_worker_id: workerId,
      ...mmPayload,
    },
    updatedAt: new Date().toISOString(),
  };
  return runMobileMoneySubFlow(nextState, '', profile, {
    paymentService: ctx.paymentService,
    getFallbackUrl: () =>
      ctx.paymentService.createPaymentUrl(
        profile.id,
        fee,
        description,
        PaymentRequestType.RECOMMENDATION_CONTACT,
        { recommendationWorkerId: workerId },
      ),
  });
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
