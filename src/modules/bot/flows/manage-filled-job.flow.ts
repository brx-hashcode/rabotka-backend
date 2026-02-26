import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import {
  formatFilledJobsListPage,
  formatFilledJobDetail,
  formatJobCompletedToWorker,
  formatJobCancelledByEmployerToWorker,
  type FilledJobListItem,
} from '../messages/application.messages';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type ManageFilledJobContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;

export async function runManageFilledJobFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ManageFilledJobContext,
): Promise<FlowResult> {
  const payload = state.payload ?? {};
  const items = (payload.items as FilledJobListItem[]) ?? [];
  const pageIndex = (payload.pageIndex as number) ?? 0;
  const step = (payload.step as 'list' | 'detail') ?? 'list';
  const selectedItem = payload.selectedItem as FilledJobListItem | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (items.length === 0) {
    return {
      reply: ["*AUCUNE MISSION POURVUE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  const isMenu =
    trimmed === '7' ||
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '));
  if (isMenu) return goToMenu();

  if (step === 'detail') {
    if (trimmed === '4') return goToMenu();

    if (trimmed === '3') {
      const slice = items.slice(
        pageIndex * PAGE_SIZE,
        pageIndex * PAGE_SIZE + PAGE_SIZE,
      );
      const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
      const message = formatFilledJobsListPage(slice, hasMore);
      return {
        reply: [message],
        nextState: {
          ...state,
          payload: {
            ...payload,
            step: 'list',
            selectedItem: undefined,
          },
          updatedAt: new Date().toISOString(),
        },
      };
    }

    if (trimmed === '1') {
      const applicationId = selectedItem?.applicationId;
      if (!applicationId) {
        return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
      }
      try {
        const updated = await ctx.applicationService.markJobCompleted(
          applicationId,
          profile.id,
        );
        await ctx.notificationService.sendJobCompletedToWorker(applicationId);
        const amount = updated.job_offer?.amount ?? selectedItem.amount;
        return {
          reply: [
            [
              '*Mission marquée comme terminée !*',
              '',
              `Le gain de ${Number(amount).toLocaleString('fr-FR')} FCFA a été enregistré pour le worker.`,
              '',
              "Tapez 'Menu' pour revenir.",
            ].join('\n'),
          ],
          clearState: true,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '*IMPOSSIBLE.*';
        return { reply: [`❌ ${msg}`], nextState: state };
      }
    }

    if (trimmed === '2') {
      const applicationId = selectedItem?.applicationId;
      if (!applicationId) {
        return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
      }
      try {
        await ctx.applicationService.cancelAcceptedByEmployer(
          applicationId,
          profile.id,
        );
        await ctx.notificationService.sendJobCancelledByEmployerToWorker(
          applicationId,
        );
        return {
          reply: [
            [
              '*Mission annulée. L\'offre est de nouveau ouverte aux candidatures.*',
              '',
              "Tapez 'Menu' pour revenir.",
            ].join('\n'),
          ],
          clearState: true,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '*IMPOSSIBLE.*';
        return { reply: [`❌ ${msg}`], nextState: state };
      }
    }

    if (selectedItem) {
      return {
        reply: [formatFilledJobDetail(selectedItem)],
        nextState: state,
      };
    }
    return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
  }

  if (trimmed === '6') {
    const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
    if (!hasMore) {
      return {
        reply: [
          "*RÉPONDEZ PAR UN NUMÉRO (1-5), 6 (VOIR PLUS) OU 7 (MENU).*",
        ],
        nextState: state,
      };
    }
    const nextPageIndex = pageIndex + 1;
    const slice = items.slice(
      nextPageIndex * PAGE_SIZE,
      nextPageIndex * PAGE_SIZE + PAGE_SIZE,
    );
    const hasMoreNext = items.length > (nextPageIndex + 1) * PAGE_SIZE;
    const message = formatFilledJobsListPage(slice, hasMoreNext);
    return {
      reply: [message],
      nextState: {
        ...state,
        payload: { ...payload, pageIndex: nextPageIndex, step: 'list' },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
  const slice = items.slice(
    pageIndex * PAGE_SIZE,
    pageIndex * PAGE_SIZE + PAGE_SIZE,
  );
  if (choice >= 1 && choice <= PAGE_SIZE && choice <= slice.length) {
    const item = slice[choice - 1];
    return {
      reply: [formatFilledJobDetail(item)],
      nextState: {
        ...state,
        payload: {
          ...payload,
          step: 'detail',
          selectedItem: item,
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const n = slice.length;
  const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
  return {
    reply: [
      `*RÉPONDEZ PAR UN NUMÉRO (1-${n})${hasMore ? ', 6 (VOIR PLUS)' : ''} OU 7 (MENU).*`,
    ],
    nextState: state,
  };
}

export function getManageFilledJobInitialState(
  items: FilledJobListItem[],
): BotState {
  return {
    flowId: FLOW_IDS.MANAGE_FILLED_JOB,
    step: 1,
    payload: { items, pageIndex: 0, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}
