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
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';

export type CandidaturesListContext = {
  prisma: PrismaService;
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

const PAGE_SIZE = 5;
type CandidaturesStep = 'list' | 'detail';

function isMenuCommand(trimmedInput: string, normalizedInput: string): boolean {
  return (
    trimmedInput === '7' ||
    normalizedInput === 'retour' ||
    CMD_MENU.some(
      (command) =>
        normalizedInput === command ||
        normalizedInput.startsWith(command + ' '),
    )
  );
}

function getPageSlice(items: CandidatureListItem[], pageIndex: number) {
  return items.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);
}

function hasMoreItems(
  items: CandidatureListItem[],
  pageIndex: number,
): boolean {
  return items.length > (pageIndex + 1) * PAGE_SIZE;
}

function buildListState(
  state: BotState,
  payload: Record<string, unknown>,
  pageIndex: number,
): BotState {
  return {
    ...state,
    payload: { ...payload, pageIndex, step: 'list' },
    updatedAt: new Date().toISOString(),
  };
}

function buildDetailState(
  state: BotState,
  payload: Record<string, unknown>,
  selectedItem: CandidatureListItem,
): BotState {
  return {
    ...state,
    payload: {
      ...payload,
      step: 'detail',
      selectedApplicationId: selectedItem.id,
      selectedItem,
    },
    updatedAt: new Date().toISOString(),
  };
}

function buildBackToListState(
  state: BotState,
  payload: Record<string, unknown>,
): BotState {
  return {
    ...state,
    payload: {
      ...payload,
      step: 'list',
      selectedApplicationId: undefined,
      selectedItem: undefined,
    },
    updatedAt: new Date().toISOString(),
  };
}

function formatSelectedItemDetail(item: CandidatureListItem): string {
  return formatCandidatureDetail({
    firstName: item.firstName,
    lastName: item.lastName,
    email: item.email,
    status: item.status,
    score: item.score,
    avatarUrl: item.avatarUrl,
    offerTitle: item.offerTitle,
  });
}

function buildInvalidChoiceMessage(
  items: CandidatureListItem[],
  pageIndex: number,
) {
  const n = getPageSlice(items, pageIndex).length;
  const hasMore = hasMoreItems(items, pageIndex);
  return `*RÉPONDEZ PAR UN NUMÉRO (1-${n}) POUR SÉLECTIONNER UN CANDIDAT${hasMore ? ', 6 (VOIR PLUS)' : ''} OU 7 (MENU).*`;
}

type DetailStepParams = {
  state: BotState;
  payload: Record<string, unknown>;
  items: CandidatureListItem[];
  pageIndex: number;
  selectedItem: CandidatureListItem | undefined;
  trimmedInput: string;
  profile: BotProfile;
  ctx: CandidaturesListContext;
  goToMenu: () => FlowResult;
};

async function handleDetailStep(params: DetailStepParams): Promise<FlowResult> {
  const {
    state,
    payload,
    items,
    pageIndex,
    selectedItem,
    trimmedInput,
    profile,
    ctx,
    goToMenu,
  } = params;

  if (trimmedInput === '4') return goToMenu();

  if (trimmedInput === '3') {
    const slice = getPageSlice(items, pageIndex);
    const message = formatCandidaturesListPage(
      slice,
      hasMoreItems(items, pageIndex),
    );
    return {
      reply: [message],
      nextState: buildBackToListState(state, payload),
    };
  }

  if (trimmedInput === '1' || trimmedInput === '2') {
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
      trimmedInput,
      profile,
      ctx,
    );
    return {
      reply: result.reply,
      nextState: result.clearState ? undefined : (result.nextState ?? acceptRefuseState),
      clearState: result.clearState,
    };
  }

  if (!selectedItem) {
    return {
      reply: ["*ERREUR. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  return {
    reply: [formatSelectedItemDetail(selectedItem)],
    nextState: state,
  };
}

function handleNextPage(
  state: BotState,
  payload: Record<string, unknown>,
  items: CandidatureListItem[],
  pageIndex: number,
): FlowResult {
  if (!hasMoreItems(items, pageIndex)) {
    return {
      reply: [
        '*RÉPONDEZ PAR UN NUMÉRO (1-5) POUR SÉLECTIONNER UN CANDIDAT OU 7 (MENU).*',
      ],
      nextState: state,
    };
  }

  const nextPageIndex = pageIndex + 1;
  const slice = getPageSlice(items, nextPageIndex);
  const message = formatCandidaturesListPage(
    slice,
    hasMoreItems(items, nextPageIndex),
  );
  return {
    reply: [message],
    nextState: buildListState(state, payload, nextPageIndex),
  };
}

function handleListSelection(
  state: BotState,
  payload: Record<string, unknown>,
  items: CandidatureListItem[],
  pageIndex: number,
  trimmedInput: string,
  ctx: CandidaturesListContext,
): FlowResult {
  const choice = /^[1-5]$/.test(trimmedInput)
    ? Number.parseInt(trimmedInput, 10)
    : 0;
  const slice = getPageSlice(items, pageIndex);

  if (!(choice >= 1 && choice <= PAGE_SIZE && choice <= slice.length)) {
    return {
      reply: [buildInvalidChoiceMessage(items, pageIndex)],
      nextState: state,
    };
  }

  const item = slice[choice - 1];
  void ctx.applicationService.markAsViewed(item.id).catch((err: unknown) =>
    console.warn(`[candidatures-list] markAsViewed failed for ${item.id}:`, err),
  );
  return {
    reply: [formatSelectedItemDetail(item)],
    nextState: buildDetailState(state, payload, item),
  };
}

export async function runCandidaturesListFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: CandidaturesListContext,
): Promise<FlowResult> {
  const payload = state.payload ?? {};
  const items = (payload.items as CandidatureListItem[]) ?? [];
  const pageIndex = (payload.pageIndex as number) ?? 0;
  const step = (payload.step as CandidaturesStep) ?? 'list';
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

  if (isMenuCommand(trimmed, normalized)) {
    return goToMenu();
  }

  if (step === 'detail') {
    return handleDetailStep({
      state,
      payload,
      items,
      pageIndex,
      selectedItem,
      trimmedInput: trimmed,
      profile,
      ctx,
      goToMenu,
    });
  }

  if (trimmed === '6') {
    return handleNextPage(state, payload, items, pageIndex);
  }

  return handleListSelection(state, payload, items, pageIndex, trimmed, ctx);
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
