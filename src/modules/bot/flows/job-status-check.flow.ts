import { PaymentFlow } from '@prisma/client';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowResult } from '../types/flow.types';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { QueueService } from '../../../common/services/queue/queue.service';
import type { ReminderJobData } from '../reminder/reminder.processor';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import { CMD_MENU, FLOW_IDS } from '../bot.constants';

export type JobStatusCheckContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  queueService: QueueService;
};

function isMenuInput(normalized: string): boolean {
  return CMD_MENU.some((c) => normalized === c || normalized === 'm');
}

function snoozeHoursFor(paymentFlow: string | undefined): number {
  switch (paymentFlow) {
    case PaymentFlow.HOURLY:
      return 1;
    case PaymentFlow.MONTHLY:
      return 24;
    default:
      return 8; // DAILY
  }
}

function snoozeLabel(paymentFlow: string | undefined): string {
  const h = snoozeHoursFor(paymentFlow);
  return h === 1 ? '1 heure' : `${h} heures`;
}

function statusPrompt(
  jobTitle: string,
  paymentFlow: string | undefined,
): string {
  return [
    `📋 *Mission en cours — ${jobTitle}*`,
    '',
    `La mission a atteint son heure prévue. Quel est son statut actuel ?`,
    '',
    `1 — ✅ Terminée — confirmer la fin de mission`,
    `2 — ⏳ Toujours en cours — me rappeler dans ${snoozeLabel(paymentFlow)}`,
    `3 — Menu`,
  ].join('\n');
}

export async function runJobStatusCheckFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: JobStatusCheckContext & { employerId?: string },
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (isMenuInput(normalized) || trimmed === '3') {
    return {
      reply: ['Tapez *MENU* pour accéder au menu principal.'],
      clearState: true,
    };
  }

  const { jobOfferId, jobTitle, applicationId, paymentFlow } = (state.payload ??
    {}) as {
    jobOfferId?: string;
    jobTitle?: string;
    applicationId?: string;
    paymentFlow?: string;
  };

  if (!jobOfferId || !applicationId) {
    return { reply: ["*ERREUR. Tapez 'MENU'.*"], clearState: true };
  }

  // Re-bind as non-optional after the guard so downstream code is typed as string
  const safeJobOfferId: string = jobOfferId;
  const safeApplicationId: string = applicationId;
  const title = jobTitle ?? 'mission';

  if (trimmed === '1') {
    // Employer confirms mission is done
    try {
      await ctx.applicationService.markJobCompleted(
        safeApplicationId,
        profile.id,
      );
      await ctx.notificationService
        .sendJobCompletedToWorker(safeApplicationId)
        .catch(() => {});
      return {
        reply: [
          [
            `✅ *Mission confirmée comme terminée !*`,
            '',
            `Les gains ont été enregistrés pour les travailleurs.`,
            '',
            `Tapez *MENU* pour revenir au menu principal.`,
          ].join('\n'),
        ],
        clearState: true,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue.';
      return {
        reply: [`❌ ${msg}\n\nTapez *MENU* pour revenir.`],
        clearState: true,
      };
    }
  }

  if (trimmed === '2') {
    const hours = snoozeHoursFor(paymentFlow);
    const snoozeCount = ((state.payload?.snoozeCount as number) ?? 0) + 1;
    const snoozeUntil = new Date(
      Date.now() + hours * 60 * 60 * 1000,
    ).toISOString();
    const employerId = ctx.employerId ?? profile.id;

    // Schedule a proactive re-ask after the snooze duration
    await ctx.queueService
      .addJob<ReminderJobData>(
        WHATSAPP_REMINDERS_QUEUE,
        {
          type: 'reminder_job_status',
          jobOfferId: safeJobOfferId,
          employerId,
          applicationId: safeApplicationId,
          paymentFlow: paymentFlow ?? 'DAILY',
        },
        {
          jobId: `job-status-${safeJobOfferId}-snooze-${snoozeCount}`,
          delay: hours * 60 * 60 * 1000,
        },
      )
      .catch(() => {});

    return {
      reply: [
        [
          `⏳ *D'accord, je vous rappelle dans ${snoozeLabel(paymentFlow)}.*`,
          '',
          `N'oubliez pas de confirmer la fin de la mission *"${title}"* une fois qu'elle est terminée.`,
          '',
          `Tapez *MENU* pour accéder au menu ou *1* pour confirmer la fin maintenant.`,
        ].join('\n'),
      ],
      nextState: {
        ...state,
        flowId: FLOW_IDS.JOB_STATUS_CHECK,
        payload: {
          ...state.payload,
          snoozeUntil,
          snoozeCount,
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // Unrecognised input — re-show the prompt
  return {
    reply: [statusPrompt(title, paymentFlow)],
    nextState: state,
  };
}

export function getJobStatusCheckInitialState(params: {
  jobOfferId: string;
  jobTitle: string;
  applicationId: string;
  paymentFlow: string;
}): BotState {
  return {
    flowId: FLOW_IDS.JOB_STATUS_CHECK,
    step: 0,
    payload: {
      jobOfferId: params.jobOfferId,
      jobTitle: params.jobTitle,
      applicationId: params.applicationId,
      paymentFlow: params.paymentFlow,
      snoozeCount: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function jobStatusCheckPromptMessage(
  jobTitle: string,
  paymentFlow: string,
): string {
  return statusPrompt(jobTitle, paymentFlow);
}
