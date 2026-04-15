import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  getCancelApplicationInitialState,
  runCancelApplicationFlow,
} from './cancel-application.flow';
import { menuMessage } from '../messages/menu.messages';
import {
  formatMyApplicationsList,
  formatMyApplicationDetailWithCancel,
  formatMyApplicationDetailReadOnly,
  formatMyApplicationDetailWaitingPayment,
  formatMyApplicationDetailWaitingPaymentPaid,
  type ApplicationForList,
} from '../messages/application.messages';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { PaymentService } from '../../payments/payment.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import {
  getUnlockContactInitialState,
  runUnlockContactFlow,
} from './unlock-contact.flow';

export type MyApplicationsContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: PaymentService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

function formatDetail(
  app: NonNullable<Awaited<ReturnType<ApplicationService['findById']>>>,
  isWaitingPaymentPaidByCurrentUser: boolean,
): string {
  const isWaitingPayment = app.status === 'WAITING_PAYMENT';
  const isCancellable = app.status === 'PENDING' || app.status === 'ACCEPTED';
  const formatter = isWaitingPayment
    ? isWaitingPaymentPaidByCurrentUser
      ? formatMyApplicationDetailWaitingPaymentPaid
      : formatMyApplicationDetailWaitingPayment
    : isCancellable
      ? formatMyApplicationDetailWithCancel
      : formatMyApplicationDetailReadOnly;
  return formatter({
    jobTitle: app.job_offer.title,
    scheduled_at: app.job_offer.scheduled_at,
    amount: app.job_offer.amount,
    payment_flow: app.job_offer.payment_flow,
    address: app.job_offer.address,
    status: app.status,
  });
}

async function handleStep0(
  state: BotState,
  trimmed: string,
  applicationIds: string[],
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const index = /^[1-9]d*$/.test(trimmed)
    ? Number.parseInt(trimmed, 10) - 1
    : Number.NaN;

  if (Number.isNaN(index) || index < 0 || index >= applicationIds.length) {
    return buildMyApplicationsListState(profile, ctx);
  }

  const app = await ctx.applicationService.findById(applicationIds[index]);
  const canAccess =
    app &&
    (app.worker_id === profile.id || app.job_offer.employer_id === profile.id);
  if (!canAccess) {
    return {
      reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const isWaitingPaymentPaidByCurrentUser = await hasCurrentUserAlreadyPaid(
    app.id,
    profile,
    ctx,
  );
  return {
    reply: [formatDetail(app, isWaitingPaymentPaidByCurrentUser)],
    nextState: {
      ...state,
      step: 1,
      payload: { ...payload, applicationIds, selectedIndex: index },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleStep1(
  state: BotState,
  trimmed: string,
  applicationIds: string[],
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const selectedIndex = payload.selectedIndex as number | undefined;
  const applicationId =
    selectedIndex == undefined ? undefined : applicationIds[selectedIndex];

  if (!applicationId) {
    return { reply: ["*INDEX INVALIDE. TAPEZ 'MENU'.*"], clearState: true };
  }

  const app = await ctx.applicationService.findById(applicationId);
  const canAccess =
    app &&
    (app.worker_id === profile.id || app.job_offer.employer_id === profile.id);
  if (!canAccess) {
    return {
      reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const isCancellable = app.status === 'PENDING' || app.status === 'ACCEPTED';
  const isWaitingPayment = app.status === 'WAITING_PAYMENT';
  const isWaitingPaymentPaidByCurrentUser = await hasCurrentUserAlreadyPaid(
    app.id,
    profile,
    ctx,
  );
  const detailText = formatDetail(app, isWaitingPaymentPaidByCurrentUser);

  if (isWaitingPayment && !isWaitingPaymentPaidByCurrentUser && trimmed === '1') {
    const attempt = await ctx.contactUnlockService.getByApplicationId(applicationId);
    if (!attempt) {
      return {
        reply: [
          "❌ Aucune tentative de paiement en attente pour cette candidature.\n\nTapez *Menu* pour revenir.",
        ],
        clearState: true,
      };
    }
    const fees = await ctx.systemConfigService.getContactUnlockFees();
    const isEmployer = app.job_offer.employer_id === profile.id;
    const otherName = isEmployer
      ? `${app.worker?.first_name ?? ''} ${app.worker?.last_name ?? ''}`.trim() ||
        'le travailleur'
      : `${app.job_offer.employer?.first_name ?? ''} ${app.job_offer.employer?.last_name ?? ''}`.trim() ||
        "l'employeur";
    const amount = isEmployer ? fees.employerFeeFcfa : fees.workerFeeFcfa;
    const unlockState = getUnlockContactInitialState({
      attemptId: attempt.id,
      otherName,
      amount,
      expiryHours: fees.expiryHours,
    });
    const result = await runUnlockContactFlow(unlockState, '', profile, {
      contactUnlockService: ctx.contactUnlockService,
      walletService: ctx.walletService,
      paymentService: ctx.paymentService,
      botNotification: ctx.notificationService,
    });
    return {
      reply: result.reply,
      nextState: result.nextState ?? unlockState,
      clearState: result.clearState,
    };
  }

  if (
    isWaitingPayment &&
    ((isWaitingPaymentPaidByCurrentUser && trimmed === '1') ||
      (!isWaitingPaymentPaidByCurrentUser && trimmed === '2'))
  ) {
    const outcome = await ctx.contactUnlockService.rejectPendingAttemptByApplication(
      applicationId,
      profile.id,
    );
    await ctx.notificationService.sendMessage(outcome.otherPhone, outcome.otherPartyMessage);
    return {
      reply: [outcome.currentPartyMessage],
      clearState: true,
    };
  }

  if (isCancellable && trimmed === '1') {
    const cancelState = getCancelApplicationInitialState(applicationId);
    const result = await runCancelApplicationFlow(
      cancelState,
      '',
      profile,
      ctx,
    );
    return { reply: result.reply, nextState: result.nextState ?? cancelState };
  }

  const isBackToList =
    (isWaitingPayment &&
      ((isWaitingPaymentPaidByCurrentUser && trimmed === '2') ||
        (!isWaitingPaymentPaidByCurrentUser && trimmed === '3'))) ||
    (isCancellable && trimmed === '2') ||
    (!isWaitingPayment && !isCancellable && trimmed === '1');
  if (isBackToList) return buildMyApplicationsListState(profile, ctx);

  const isMenu =
    (isWaitingPayment &&
      ((isWaitingPaymentPaidByCurrentUser && trimmed === '3') ||
        (!isWaitingPaymentPaidByCurrentUser && trimmed === '4'))) ||
    (isCancellable && trimmed === '3') ||
    (!isWaitingPayment && !isCancellable && trimmed === '2');
  if (isMenu) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  return { reply: [detailText], nextState: state };
}

async function hasCurrentUserAlreadyPaid(
  applicationId: string,
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<boolean> {
  const attempt = await ctx.contactUnlockService.getByApplicationId(applicationId);
  if (!attempt) return false;
  const isEmployer = attempt.employer_id === profile.id;
  const isWorker = attempt.worker_id === profile.id;
  if (isEmployer) return attempt.employer_paid;
  if (isWorker) return attempt.worker_paid;
  return false;
}

export async function runMyApplicationsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const applicationIds = (payload.applicationIds as string[]) ?? [];
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  if (applicationIds.length === 0) {
    return { reply: ["*AUCUNE CANDIDATURE. TAPEZ 'MENU'.*"], clearState: true };
  }

  const step = state.step ?? 0;
  if (step === 0)
    return handleStep0(state, trimmed, applicationIds, profile, ctx);
  if (step === 1)
    return handleStep1(state, trimmed, applicationIds, profile, ctx);

  return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
}

export function getMyApplicationsInitialState(
  applicationIds: string[],
): BotState {
  return {
    flowId: FLOW_IDS.MY_APPLICATIONS,
    step: 0,
    payload: { applicationIds },
    updatedAt: new Date().toISOString(),
  };
}

async function buildMyApplicationsListState(
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const applications =
    profile.profile_type === 'WORKER'
      ? await ctx.applicationService.findByWorker(profile.id, { limit: 20 })
      : await ctx.applicationService.findByEmployer(profile.id, { limit: 20 });
  if (applications.length === 0) {
    return { reply: [formatMyApplicationsList([])], clearState: true };
  }
  const list: ApplicationForList[] = applications.map((a) => ({
    id: a.id,
    status: a.status,
    job_offer: {
      id: a.job_offer.id,
      title: a.job_offer.title,
      scheduled_at: a.job_offer.scheduled_at,
      amount: a.job_offer.amount,
      payment_flow: a.job_offer.payment_flow,
      address: a.job_offer.address,
      status: a.job_offer.status,
    },
  }));
  return {
    reply: [formatMyApplicationsList(list)],
    nextState: {
      flowId: FLOW_IDS.MY_APPLICATIONS,
      step: 0,
      payload: { applicationIds: applications.map((a) => a.id) },
      updatedAt: new Date().toISOString(),
    },
  };
}
