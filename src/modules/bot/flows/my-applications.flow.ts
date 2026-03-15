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
  type ApplicationForList,
} from '../messages/application.messages';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type MyApplicationsContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  cancellationSettings: { penaltyFcfa: number; thresholdHours: number };
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

function formatDetail(
  app: NonNullable<Awaited<ReturnType<ApplicationService['findById']>>>,
  isCancellable: boolean,
): string {
  const formatter = isCancellable
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
  if (!app || app.worker_id !== profile.id) {
    return {
      reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const isCancellable = app.status === 'PENDING' || app.status === 'ACCEPTED';
  return {
    reply: [formatDetail(app, isCancellable)],
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
  if (!app || app.worker_id !== profile.id) {
    return {
      reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const isCancellable = app.status === 'PENDING' || app.status === 'ACCEPTED';
  const detailText = formatDetail(app, isCancellable);

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
    (isCancellable && trimmed === '2') || (!isCancellable && trimmed === '1');
  if (isBackToList) return buildMyApplicationsListState(profile, ctx);

  const isMenu =
    (isCancellable && trimmed === '3') || (!isCancellable && trimmed === '2');
  if (isMenu) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  return { reply: [detailText], nextState: state };
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
  const applications = await ctx.applicationService.findByWorker(profile.id, {
    limit: 20,
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
      payload: { applicationIds: applications.map((a) => a.id) },
      updatedAt: new Date().toISOString(),
    },
  };
}
