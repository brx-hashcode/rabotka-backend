import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import {
  formatFilledJobsListPage,
  formatFilledJobDetail,
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

function isMenuInput(trimmed: string, normalized: string): boolean {
  return (
    normalized === 'm' ||
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  );
}

function buildListPage(
  state: BotState,
  items: FilledJobListItem[],
  pageIndex: number,
): FlowResult {
  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  const slice = items.slice(
    pageIndex * PAGE_SIZE,
    pageIndex * PAGE_SIZE + PAGE_SIZE,
  );
  const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
  return {
    reply: [formatFilledJobsListPage(slice, hasMore, pageIndex, totalPages)],
    nextState: {
      ...state,
      payload: {
        ...state.payload,
        pageIndex,
        step: 'list',
        selectedItem: undefined,
      },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleDetailComplete(
  applicationId: string,
  selectedItem: FilledJobListItem,
  ctx: ManageFilledJobContext,
  profile: BotProfile,
  note?: string,
): Promise<FlowResult> {
  try {
    const updated = await ctx.applicationService.markJobCompleted(
      applicationId,
      profile.id,
      note,
    );
    await ctx.notificationService
      .sendJobCompletedToWorker(applicationId)
      .catch((err: unknown) =>
        console.warn(`[manage-filled-job] sendJobCompletedToWorker failed for ${applicationId}:`, err),
      );
    const amount = updated.job_offer?.amount ?? selectedItem.amount;
    return {
      reply: [
        [
          '*Mission marquée comme terminée !*',
          '',
          `Le gain de ${Number(amount).toLocaleString('fr-FR')} FCFA a été enregistré pour le travailleur.`,
          '',
          "Tapez 'Menu' pour revenir.",
        ].join('\n'),
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '*IMPOSSIBLE.*';
    return { reply: [`❌ ${msg}`] };
  }
}

async function handleDetailCancel(
  applicationId: string,
  ctx: ManageFilledJobContext,
  profile: BotProfile,
  state: BotState,
): Promise<FlowResult> {
  try {
    await ctx.applicationService.cancelAcceptedByEmployer(
      applicationId,
      profile.id,
    );
    await ctx.notificationService
      .sendJobCancelledByEmployerToWorker(applicationId)
      .catch((err: unknown) =>
        console.warn(`[manage-filled-job] sendJobCancelledByEmployerToWorker failed for ${applicationId}:`, err),
      );
    return {
      reply: [
        [
          "*Mission annulée. L'offre est de nouveau ouverte aux candidatures.*",
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

async function handleDetailStep(
  state: BotState,
  trimmed: string,
  items: FilledJobListItem[],
  pageIndex: number,
  selectedItem: FilledJobListItem | undefined,
  ctx: ManageFilledJobContext,
  profile: BotProfile,
): Promise<FlowResult> {
  if (trimmed === '3') return buildListPage(state, items, pageIndex);

  const applicationId = selectedItem?.applicationId;
  if (!applicationId) {
    return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
  }

  if (trimmed === '1') {
    return {
      reply: [
        [
          '*Laissez une note sur le worker (optionnel)*',
          '',
          'Envoyez votre commentaire, ou tapez *0* pour passer.',
        ].join('\n'),
      ],
      nextState: {
        ...state,
        payload: { ...state.payload, step: 'note' },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  if (trimmed === '2') {
    return {
      reply: [
        [
          `⚠️ *Êtes-vous sûr de vouloir annuler cette mission ?*`,
          '',
          "Le travailleur sera notifié et l'offre sera rouverte aux candidatures.",
          '',
          '1- Oui, annuler la mission',
          '2- Non, revenir',
        ].join('\n'),
      ],
      nextState: {
        ...state,
        payload: { ...state.payload, step: 'cancel_confirm' },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  return {
    reply: [formatFilledJobDetail(selectedItem)],
    nextState: state,
  };
}

async function handleNoteStep(
  state: BotState,
  trimmed: string,
  ctx: ManageFilledJobContext,
  profile: BotProfile,
): Promise<FlowResult> {
  const selectedItem = state.payload?.selectedItem as
    | FilledJobListItem
    | undefined;
  const applicationId = selectedItem?.applicationId;
  if (!applicationId || !selectedItem) {
    return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
  }
  const note = trimmed === '0' ? undefined : trimmed;
  return handleDetailComplete(applicationId, selectedItem, ctx, profile, note);
}

function handleListStep(
  state: BotState,
  trimmed: string,
  items: FilledJobListItem[],
  pageIndex: number,
): FlowResult {
  const normalized = trimmed.toLowerCase();
  const totalPages = Math.ceil(items.length / PAGE_SIZE);

  if (normalized === 's' && pageIndex < totalPages - 1) {
    return buildListPage(state, items, pageIndex + 1);
  }
  if (normalized === 'p' && pageIndex > 0) {
    return buildListPage(state, items, pageIndex - 1);
  }

  const choice = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
  const slice = items.slice(
    pageIndex * PAGE_SIZE,
    pageIndex * PAGE_SIZE + PAGE_SIZE,
  );

  if (choice >= 1 && choice <= slice.length) {
    const item = slice[choice - 1];
    return {
      reply: [formatFilledJobDetail(item)],
      nextState: {
        ...state,
        payload: { ...state.payload, step: 'detail', selectedItem: item },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const n = slice.length;
  const hasMore = items.length > (pageIndex + 1) * PAGE_SIZE;
  return {
    reply: [
      `*TAPEZ UN NUMÉRO (1-${n})${pageIndex > 0 ? ', P (page préc.)' : ''}${hasMore ? ', S (page suiv.)' : ''}, M (menu).*`,
    ],
    nextState: state,
  };
}

export async function runManageFilledJobFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: ManageFilledJobContext,
): Promise<FlowResult> {
  const payload = state.payload ?? {};
  const items = (payload.items as FilledJobListItem[]) ?? [];
  const pageIndex = (payload.pageIndex as number) ?? 0;
  const step =
    (payload.step as 'list' | 'detail' | 'note' | 'cancel_confirm') ?? 'list';
  const selectedItem = payload.selectedItem as FilledJobListItem | undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (items.length === 0) {
    return {
      reply: ["*AUCUNE MISSION POURVUE. TAPEZ 'MENU'.*"],
      clearState: true,
    };
  }

  if (isMenuInput(trimmed, normalized)) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  if (trimmed === '4' && step === 'detail') {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  if (step === 'cancel_confirm') {
    const applicationId = selectedItem?.applicationId;
    if (!applicationId) {
      return { reply: ["*ERREUR. TAPEZ 'MENU'.*"], clearState: true };
    }
    if (trimmed === '1' || normalized === 'oui') {
      return handleDetailCancel(applicationId, ctx, profile, state);
    }
    return {
      reply: [formatFilledJobDetail(selectedItem)],
      nextState: {
        ...state,
        payload: { ...state.payload, step: 'detail' },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  if (step === 'note') {
    return handleNoteStep(state, trimmed, ctx, profile);
  }

  if (step === 'detail') {
    return handleDetailStep(
      state,
      trimmed,
      items,
      pageIndex,
      selectedItem,
      ctx,
      profile,
    );
  }

  return handleListStep(state, trimmed, items, pageIndex);
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
