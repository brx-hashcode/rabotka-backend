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
import {
  type CarouselCard,
  cardBodyBudget,
  carouselReply,
  singleCardReply,
  composeCardBody,
  profileImageUrl,
} from '../../../common/constants/whatsapp-carousel';
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
import type { PortfolioService } from '../../portfolio/portfolio.service';
import { buildPortfolioReply } from '../utils/portfolio-link';

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
  portfolioService: PortfolioService;
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
    '2- Voir le portfolio',
    '3- Liste des candidats',
    '4- Menu',
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
      payload.walletEligible !== false,
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

/**
 * The portfolio CTA for a worker the employer has selected. The detail step
 * only carries the worker id, so the name (used in the template body) is read
 * back here — one lookup on an already-selected id.
 */
async function portfolioReplyFor(
  workerId: string,
  ctx: RecommendedProfilesContext,
): Promise<string> {
  const worker = await ctx.prisma.profile.findUnique({
    where: { id: workerId },
    select: { first_name: true, last_name: true },
  });
  const name = worker
    ? `${worker.first_name} ${worker.last_name}`.trim()
    : 'ce candidat';
  return buildPortfolioReply(workerId, name, ctx.portfolioService);
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
  if (trimmed === '4') return goToMenu();
  if (trimmed === '3') return showList(workerIds, workerScores, state, ctx);

  // Portfolio CTA. State stays on the detail step so the employer can carry on
  // with "1- Contacter" right after looking at the work.
  if (trimmed === '2') {
    return {
      reply: [await portfolioReplyFor(selectedWorkerId, ctx)],
      nextState: state,
    };
  }

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
    reply: [`Tapez *1*, *2*, *3* ou *4*.\n${subMenu()}`],
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
  walletEligible = true,
): Promise<FlowResult> {
  const fee = await ctx.systemConfig.getRecommendationContactFee();
  const balance = await ctx.walletService.getProfileWalletBalance(profile.id);

  // Input mapping depends on whether the wallet option was offered. See
  // showPaymentMethodPrompt for the matching menu numbering.
  const action = mapPaymentInput(trimmed, walletEligible);

  if (action === 'cancel') {
    return showWorkerDetail(
      selectedWorkerId,
      workerIds,
      workerScores,
      state,
      ctx,
      jobOfferId,
    );
  }

  if (action === 'wallet') {
    if (balance < fee) {
      // Defence-in-depth: rebuild the prompt with the wallet option hidden so
      // the user has a coherent set of choices, even if the balance shifted
      // mid-flow.
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
    return processWalletPayment(selectedWorkerId, profile, fee, ctx);
  }

  if (action === 'mobile_money') {
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

type PaymentAction = 'wallet' | 'mobile_money' | 'cancel' | 'invalid';

function mapPaymentInput(
  trimmed: string,
  walletEligible: boolean,
): PaymentAction {
  if (walletEligible) {
    if (trimmed === '1') return 'wallet';
    if (trimmed === '2') return 'mobile_money';
    if (trimmed === '3') return 'cancel';
    return 'invalid';
  }
  // Wallet hidden: 1 = mobile money, 2 = cancel.
  if (trimmed === '1') return 'mobile_money';
  if (trimmed === '2') return 'cancel';
  return 'invalid';
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

/** Fields a worker row must carry to be rendered in the recommended list. */
export type WorkerListItem = {
  id: string;
  first_name: string;
  last_name: string;
  reliability_score: number | null;
  description: string | null;
  avatar_url: string | null;
};

/** Prisma `select` for WorkerListItem — keep both call sites in sync. */
export const WORKER_LIST_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  reliability_score: true,
  description: true,
  avatar_url: true,
} as const;

/**
 * Single source of truth for rendering a page of recommended workers: a native
 * WhatsApp carousel (one "Sélectionner" button per card, positional id matches
 * the numeric selection the detail step parses), falling back to the text list
 * when the count is outside 2..5 (Meta requires at least 2 cards).
 *
 * Used by BOTH the flow's list step and the orchestrator's entry-point command
 * — they previously rendered the list separately, so the entry point silently
 * kept showing text after the carousel shipped.
 *
 * Card body must be a single line — carousel cards reject line breaks — so
 * fields get inline labels joined by " • " instead of real bullets. Mirrors the
 * same two metrics formatWorkerCard() shows in the text fallback:
 * reliability_score ("Fiabilité") and the computed match score ("Score IA") —
 * two distinct fields, not one number under two labels. Description is
 * unbounded free text (the name lives in the card's own `title`), so it's
 * ordered last: composeCardBody truncates whichever field overflows, and
 * putting the bounded scores first guarantees they're never the ones cut off.
 */
export function buildWorkerListReply(
  orderedWorkers: WorkerListItem[],
  workerScores: Record<string, number>,
): string {
  const lines = [
    '*Travailleurs recommandés*',
    '',
    ...orderedWorkers.map((w, i) => {
      const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
      return formatWorkerCard(i + 1, w, aiScore);
    }),
    '',
    '*Tapez le numéro pour voir le profil complet ou 7 pour le menu.*',
  ];

  const cards: CarouselCard[] = orderedWorkers.map((w) => {
    const name = `${w.first_name} ${w.last_name}`.trim();
    const reliability = w.reliability_score ?? 100;
    const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
    const desc = w.description ?? '';
    const body = composeCardBody(
      [
        { label: 'Fiabilité', value: `${reliability}/100` },
        aiScore > 0 ? { label: 'Score IA', value: `${aiScore}%` } : null,
        desc ? { label: 'À propos', value: desc } : null,
      ].filter((f): f is { label: string; value: string } => f !== null),
      cardBodyBudget('profiles', name),
    );
    return { title: name, image: profileImageUrl(w.avatar_url), body };
  });

  if (cards.length === 1) return singleCardReply('profiles', cards[0]);
  return carouselReply('profiles', cards) ?? lines.join('\n');
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
    select: WORKER_LIST_SELECT,
  });

  const workerMap = new Map(workers.map((w) => [w.id, w]));
  const orderedWorkers = pageWorkerIds
    .map((id) => workerMap.get(id))
    .filter(Boolean) as typeof workers;

  // Store the rendered order explicitly so selection always maps to the displayed item
  const renderedWorkerIds = orderedWorkers.map((w) => w.id);

  const reply = await buildWorkerListReply(
    orderedWorkers,
    workerScores,
  );

  return {
    reply: [reply],
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
  // Always show a header image: the worker's avatar, or the profile
  // placeholder when they haven't set one (rather than no image at all).
  const reply = [`[IMG:${profileImageUrl(worker.avatar_url)}]\n${detailText}`];

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

  // When the wallet is too low we drop option 1 entirely (rather than show it
  // as "indisponible") so the user can never even try a payment we know will
  // fail. The remaining options are renumbered 1/2 — see handlePaymentStep for
  // the matching input mapping. `hasFunds` is persisted in payload to keep
  // numbering stable across the round-trip.
  const options = hasFunds
    ? [
        `1- Utiliser mon crédit (${fee.toLocaleString('fr-FR')} FCFA)`,
        '2- Payer par mobile money',
        '3- Annuler',
      ]
    : ['1- Payer par mobile money', '2- Annuler'];

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
        walletEligible: hasFunds,
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
