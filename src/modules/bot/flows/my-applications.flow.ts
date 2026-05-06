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
  type MyApplicationDetailParams,
} from '../messages/application.messages';
import { ApplicationStatus } from '@prisma/client';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { IPaymentUrlService } from '../types/payment-url.types';
import type { SystemConfigService } from '../../system-config/system-config.service';
import type { InterestSignalService } from '../../interest-graph/interest-signal.service';
import {
  getUnlockContactInitialState,
  runUnlockContactFlow,
} from './unlock-contact.flow';

export type MyApplicationsContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  paymentService: IPaymentUrlService;
  systemConfigService: SystemConfigService;
  interestSignalService: InterestSignalService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export type MyApplicationsListMode = 'all' | 'pending_payments';

type ApplicationDetail = NonNullable<
  Awaited<ReturnType<ApplicationService['findById']>>
>;

type Step1NavResult = 'list' | 'menu' | null;

function pickDetailFormatter(
  status: ApplicationDetail['status'],
  isWaitingPaymentPaidByCurrentUser: boolean,
): (params: MyApplicationDetailParams) => string {
  if (status === ApplicationStatus.WAITING_PAYMENT) {
    if (isWaitingPaymentPaidByCurrentUser) {
      return formatMyApplicationDetailWaitingPaymentPaid;
    }
    return formatMyApplicationDetailWaitingPayment;
  }
  if (
    status === ApplicationStatus.PENDING ||
    status === ApplicationStatus.ACCEPTED
  ) {
    return formatMyApplicationDetailWithCancel;
  }
  return formatMyApplicationDetailReadOnly;
}

function formatDetail(
  app: ApplicationDetail,
  isWaitingPaymentPaidByCurrentUser: boolean,
): string {
  const formatter = pickDetailFormatter(
    app.status,
    isWaitingPaymentPaidByCurrentUser,
  );
  return formatter({
    jobTitle: app.job_offer.title,
    scheduled_at: app.job_offer.scheduled_at,
    amount: app.job_offer.amount,
    payment_flow: app.job_offer.payment_flow,
    address: app.job_offer.address,
    status: app.status,
  });
}

function buildUnlockOtherNameForApplication(
  app: ApplicationDetail,
  profileId: string,
): string {
  const isEmployer = app.job_offer.employer_id === profileId;
  if (isEmployer) {
    const name =
      `${app.worker?.first_name ?? ''} ${app.worker?.last_name ?? ''}`.trim();
    return name || 'le travailleur';
  }
  const name =
    `${app.job_offer.employer?.first_name ?? ''} ${app.job_offer.employer?.last_name ?? ''}`.trim();
  return name || "l'employeur";
}

function step1WaitingPaymentNav(
  trimmed: string,
  isWaitingPaymentPaidByCurrentUser: boolean,
): Step1NavResult {
  if (isWaitingPaymentPaidByCurrentUser) {
    if (trimmed === '2') return 'list';
    if (trimmed === '3') return 'menu';
    return null;
  }
  if (trimmed === '3') return 'list';
  if (trimmed === '4') return 'menu';
  return null;
}

function step1CancellableNav(trimmed: string): Step1NavResult {
  if (trimmed === '2') return 'list';
  if (trimmed === '3') return 'menu';
  return null;
}

function step1ReadOnlyNav(trimmed: string): Step1NavResult {
  if (trimmed === '1') return 'list';
  if (trimmed === '2') return 'menu';
  return null;
}

function step1NavAction(
  trimmed: string,
  isWaitingPayment: boolean,
  isWaitingPaymentPaidByCurrentUser: boolean,
  isCancellable: boolean,
): Step1NavResult {
  if (isWaitingPayment) {
    return step1WaitingPaymentNav(trimmed, isWaitingPaymentPaidByCurrentUser);
  }
  if (isCancellable) {
    return step1CancellableNav(trimmed);
  }
  return step1ReadOnlyNav(trimmed);
}

async function tryHandleStep1WaitingPaymentPay(params: {
  trimmed: string;
  isWaitingPayment: boolean;
  isWaitingPaymentPaidByCurrentUser: boolean;
  applicationId: string;
  app: ApplicationDetail;
  profile: BotProfile;
  ctx: MyApplicationsContext;
}): Promise<FlowResult | null> {
  const {
    trimmed,
    isWaitingPayment,
    isWaitingPaymentPaidByCurrentUser,
    applicationId,
    app,
    profile,
    ctx,
  } = params;
  if (
    !isWaitingPayment ||
    isWaitingPaymentPaidByCurrentUser ||
    trimmed !== '1'
  ) {
    return null;
  }

  const attempt =
    await ctx.contactUnlockService.getByApplicationId(applicationId);
  if (!attempt) {
    return {
      reply: [
        '❌ Aucune tentative de paiement en attente pour cette candidature.\n\nTapez *Menu* pour revenir.',
      ],
      clearState: true,
    };
  }
  const fees = await ctx.systemConfigService.getContactUnlockFees();
  const isEmployer = app.job_offer.employer_id === profile.id;
  const otherName = buildUnlockOtherNameForApplication(app, profile.id);
  const amount = isEmployer ? fees.employerFeeFcfa : fees.workerFeeFcfa;
  const unlockState = getUnlockContactInitialState({
    attemptId: attempt.id,
    otherName,
    amount,
    expiresAt: attempt.expires_at,
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

async function tryHandleStep1WaitingPaymentReject(params: {
  trimmed: string;
  isWaitingPayment: boolean;
  isWaitingPaymentPaidByCurrentUser: boolean;
  applicationId: string;
  profile: BotProfile;
  ctx: MyApplicationsContext;
}): Promise<FlowResult | null> {
  const {
    trimmed,
    isWaitingPayment,
    isWaitingPaymentPaidByCurrentUser,
    applicationId,
    profile,
    ctx,
  } = params;
  const isRejectChoice =
    (isWaitingPaymentPaidByCurrentUser && trimmed === '1') ||
    (!isWaitingPaymentPaidByCurrentUser && trimmed === '2');
  if (!isWaitingPayment || !isRejectChoice) {
    return null;
  }

  const outcome =
    await ctx.contactUnlockService.rejectPendingAttemptByApplication(
      applicationId,
      profile.id,
    );
  const notifyPhone = String(outcome.otherPhone ?? '');
  if (notifyPhone.length > 0) {
    await ctx.notificationService.sendMessage(
      notifyPhone,
      String(outcome.otherPartyMessage),
    );
  }
  return {
    reply: [outcome.currentPartyMessage],
    clearState: true,
  };
}

async function handleStep0(
  state: BotState,
  trimmed: string,
  applicationIds: string[],
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const listMode: MyApplicationsListMode =
    (payload.listMode as MyApplicationsListMode | undefined) ?? 'all';
  const index = /^[1-9]\d*$/.test(trimmed)
    ? Number.parseInt(trimmed, 10) - 1
    : Number.NaN;

  if (Number.isNaN(index) || index < 0 || index >= applicationIds.length) {
    return buildMyApplicationsListState(profile, ctx, listMode);
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
  const listMode: MyApplicationsListMode =
    (payload.listMode as MyApplicationsListMode | undefined) ?? 'all';
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

  const payResult = await tryHandleStep1WaitingPaymentPay({
    trimmed,
    isWaitingPayment,
    isWaitingPaymentPaidByCurrentUser,
    applicationId,
    app,
    profile,
    ctx,
  });
  if (payResult) return payResult;

  const rejectResult = await tryHandleStep1WaitingPaymentReject({
    trimmed,
    isWaitingPayment,
    isWaitingPaymentPaidByCurrentUser,
    applicationId,
    profile,
    ctx,
  });
  if (rejectResult) return rejectResult;

  if (isCancellable && trimmed === '1') {
    const cancelState = getCancelApplicationInitialState(applicationId);
    const { cancellationThresholdHours } =
      await ctx.systemConfigService.getFees();
    const result = await runCancelApplicationFlow(cancelState, '', profile, {
      ...ctx,
      cancellationThresholdHours,
    });
    return { reply: result.reply, nextState: result.nextState ?? cancelState };
  }

  const nav = step1NavAction(
    trimmed,
    isWaitingPayment,
    isWaitingPaymentPaidByCurrentUser,
    isCancellable,
  );
  if (nav === 'list') {
    return buildMyApplicationsListState(profile, ctx, listMode);
  }
  if (nav === 'menu') {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  return { reply: [detailText], nextState: state };
}

async function hasCurrentUserAlreadyPaid(
  applicationId: string,
  profile: BotProfile,
  ctx: MyApplicationsContext,
): Promise<boolean> {
  const attempt =
    await ctx.contactUnlockService.getByApplicationId(applicationId);
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
  listMode: MyApplicationsListMode = 'all',
): BotState {
  return {
    flowId: FLOW_IDS.MY_APPLICATIONS,
    step: 0,
    payload: { applicationIds, listMode },
    updatedAt: new Date().toISOString(),
  };
}

async function buildMyApplicationsListState(
  profile: BotProfile,
  ctx: MyApplicationsContext,
  listMode: MyApplicationsListMode = 'all',
): Promise<FlowResult> {
  const statusFilter =
    listMode === 'pending_payments'
      ? ApplicationStatus.WAITING_PAYMENT
      : undefined;
  const applications =
    profile.profile_type === 'WORKER'
      ? await ctx.applicationService.findByWorker(profile.id, {
          limit: 20,
          ...(statusFilter ? { status: statusFilter } : {}),
        })
      : await ctx.applicationService.findByEmployer(profile.id, {
          limit: 20,
          ...(statusFilter ? { status: statusFilter } : {}),
        });
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
      payload: {
        applicationIds: applications.map((a) => a.id),
        listMode,
      },
      updatedAt: new Date().toISOString(),
    },
  };
}
