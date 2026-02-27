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
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

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
    return {
      reply: [menuMessage(profile.profile_type)],
      clearState: true,
    };
  }

  if (applicationIds.length === 0) {
    return {
      reply: ["*AUCUNE CANDIDATURE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const step = state.step ?? 0;

  // Step 0: list view, expect user to select an application by number
  if (step === 0) {
    const index = /^[1-9]\d*$/.test(trimmed)
      ? Number.parseInt(trimmed, 10) - 1
      : Number.NaN;
    if (Number.isNaN(index) || index < 0 || index >= applicationIds.length) {
      // Invalid input: rebuild and resend the list view
      return buildMyApplicationsListState(profile, ctx);
    }

    {
      const applicationId = applicationIds[index];
      const app = await ctx.applicationService.findById(applicationId);
      if (!app || app.worker_id !== profile.id) {
        return {
          reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
          clearState: true,
        };
      }
      const isCancellable =
        app.status === 'PENDING' || app.status === 'ACCEPTED';
      const detailText = (isCancellable
        ? formatMyApplicationDetailWithCancel
        : formatMyApplicationDetailReadOnly)({
        jobTitle: app.job_offer.title,
        scheduled_at: app.job_offer.scheduled_at,
        amount: app.job_offer.amount,
        payment_flow: app.job_offer.payment_flow,
        address: app.job_offer.address,
        status: app.status,
      });
      return {
        reply: [detailText],
        nextState: {
          ...state,
          step: 1,
          payload: {
            ...payload,
            applicationIds,
            selectedIndex: index,
          },
          updatedAt: new Date().toISOString(),
        },
      };
    }
  }

  // Step 1: detail view for a selected application
  if (step === 1) {
    const selectedIndex = payload.selectedIndex as number | undefined;
    const applicationId =
      selectedIndex !== undefined ? applicationIds[selectedIndex] : undefined;
    if (!applicationId) {
      return {
        reply: ["*INDEX INVALIDE. TAPEZ 'MENU'.*"],
        clearState: true,
      };
    }

    const app = await ctx.applicationService.findById(applicationId);
    if (!app || app.worker_id !== profile.id) {
      return {
        reply: ["*CANDIDATURE INTROUVABLE. TAPEZ 'MENU'.*"],
        clearState: true,
      };
    }

    const isCancellable =
      app.status === 'PENDING' || app.status === 'ACCEPTED';
    const formatter = isCancellable
      ? formatMyApplicationDetailWithCancel
      : formatMyApplicationDetailReadOnly;
    const detailText = formatter({
      jobTitle: app.job_offer.title,
      scheduled_at: app.job_offer.scheduled_at,
      amount: app.job_offer.amount,
      payment_flow: app.job_offer.payment_flow,
      address: app.job_offer.address,
      status: app.status,
    });

    if (isCancellable && trimmed === '1') {
      const cancelState = getCancelApplicationInitialState(applicationId);
      const result = await runCancelApplicationFlow(
        cancelState,
        '',
        profile,
        ctx,
      );
      return {
        reply: result.reply,
        nextState: result.nextState ?? cancelState,
      };
    }

    if (
      (isCancellable && trimmed === '2') ||
      (!isCancellable && trimmed === '1')
    ) {
      return buildMyApplicationsListState(profile, ctx);
    }

    const isMenuChoice =
      (isCancellable && trimmed === '3') ||
      (!isCancellable && trimmed === '2');
    if (isMenuChoice) {
      return {
        reply: [menuMessage(profile.profile_type)],
        clearState: true,
      };
    }

    // Unknown input: repeat the detail view instructions
    return {
      reply: [detailText],
      nextState: state,
    };
  }

  return {
    reply: ["*ERREUR. TAPEZ 'MENU'.*"],
    clearState: true,
  };
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
    return {
      reply: [formatMyApplicationsList([])],
      clearState: true,
    };
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
  const applicationIds = applications.map((a) => a.id);
  const message = formatMyApplicationsList(list);
  return {
    reply: [message],
    nextState: {
      flowId: FLOW_IDS.MY_APPLICATIONS,
      step: 0,
      payload: { applicationIds },
      updatedAt: new Date().toISOString(),
    },
  };
}
