import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import {
  formatCandidaturesListPage,
  formatCandidatureDetail,
  type CandidatureListItem,
} from '../messages/application.messages';
import {
  getAcceptRefuseInitialState,
  runAcceptRefuseCandidateFlow,
} from './accept-refuse-candidate.flow';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';

export type CandidaturesListContext = {
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;

export async function runCandidaturesListFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: CandidaturesListContext,
): Promise<FlowResult> {
  const payload = state.payload ?? {};
  const items = (payload.items as CandidatureListItem[]) ?? [];
  const pageIndex = (payload.pageIndex as number) ?? 0;
  const step = (payload.step as 'list' | 'detail') ?? 'list';
  const selectedItem = payload.selectedItem as CandidatureListItem | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (items.length === 0) {
    return {
      reply: ["*AUCUNE CANDIDATURE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    trimmed === '7' ||
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' ')) ||
    normalized === 'retour'
  ) {
    return goToMenu();
  }

  if (step === 'detail') {
    if (trimmed === '4') return goToMenu();

    if (trimmed === '3') {
      const slice = items.slice(
        pageIndex * PAGE_SIZE,
        pageIndex * PAGE_SIZE + PAGE_SIZE,
      );
      const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
      const message = formatCandidaturesListPage(slice, hasMore);
      return {
        reply: [message],
        nextState: {
          ...state,
          payload: {
            ...payload,
            step: 'list',
            selectedApplicationId: undefined,
            selectedItem: undefined,
          },
          updatedAt: new Date().toISOString(),
        },
      };
    }

    if (trimmed === '1' || trimmed === '2') {
      const applicationId = selectedItem?.id;
      if (!applicationId) {
        return {
          reply: ["*ERREUR. TAPEZ 'MENU'.*"],
          clearState: true,
        };
      }
      const acceptRefuseState = getAcceptRefuseInitialState(applicationId);
      const result = await runAcceptRefuseCandidateFlow(
        acceptRefuseState,
        '',
        profile,
        ctx,
      );
      return {
        reply: result.reply,
        nextState: result.nextState ?? acceptRefuseState,
      };
    }

    if (selectedItem) {
      return {
        reply: [
          formatCandidatureDetail({
            firstName: selectedItem.firstName,
            lastName: selectedItem.lastName,
            email: selectedItem.email,
            status: selectedItem.status,
            score: selectedItem.score,
            avatarUrl: selectedItem.avatarUrl,
          }),
        ],
        nextState: state,
      };
    }
    return {
      reply: ["*ERREUR. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  if (trimmed === '6') {
    const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
    if (!hasMore) {
      return {
        reply: [
          "*RÉPONDEZ PAR UN NUMÉRO (1-5) POUR SÉLECTIONNER UN CANDIDAT, 6 (VOIR PLUS) OU 7 (MENU).*",
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
    const message = formatCandidaturesListPage(slice, hasMoreNext);
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
    const detailMessage = formatCandidatureDetail({
      firstName: item.firstName,
      lastName: item.lastName,
      email: item.email,
      status: item.status,
      score: item.score,
      avatarUrl: item.avatarUrl,
    });
    return {
      reply: [detailMessage],
      nextState: {
        ...state,
        payload: {
          ...payload,
          step: 'detail',
          selectedApplicationId: item.id,
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
      `*RÉPONDEZ PAR UN NUMÉRO (1-${n}) POUR SÉLECTIONNER UN CANDIDAT${hasMore ? ', 6 (VOIR PLUS)' : ''} OU 7 (MENU).*`,
    ],
    nextState: state,
  };
}

export function getCandidaturesListInitialState(
  items: CandidatureListItem[],
): BotState {
  return {
    flowId: FLOW_IDS.CANDIDATURES_LIST,
    step: 1,
    payload: { items, pageIndex: 0, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}
