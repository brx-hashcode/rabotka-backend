import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowResult } from '../types/flow.types';
import { CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import { JobOfferStatus } from '@prisma/client';

/**
 * Tiny state machine driving the menu shown to an employer after a
 * worker cancels their candidature. The notification message that set
 * the state is built in `formatCancellationToEmployer`.
 *
 *   1- Voir les autres candidatures   → orchestrator-level hand-off
 *                                       (signalled by `handoff: 'candidatures'`)
 *   2- Supprimer l'offre              → 2-step confirm + soft-cancel
 *   Menu / m                          → back to menu
 *
 * Note: "Republier l'offre" was intentionally removed — when a worker
 * cancels, the cancel handler already flips the offer back to ACTIVE
 * (or PARTIALLY_FILLED), so republishing is misleading.
 */

export type PostCancellationActionsContext = {
  prisma: PrismaService;
};

export type PostCancellationHandoff = 'candidatures';

export type PostCancellationFlowResult = FlowResult & {
  /** When set, the orchestrator should run the named flow next instead
   *  of replying with the placeholder text. */
  handoff?: { type: PostCancellationHandoff; jobOfferId: string };
};

type Payload = {
  jobOfferId?: string;
  jobOfferTitle?: string;
  /** Set after the user picks "2" — we then expect a yes/no confirmation. */
  awaitingDeleteConfirm?: boolean;
};

const ACTIONS_PROMPT = [
  '*Actions disponibles :*',
  '',
  '1- Voir les autres candidatures',
  "2- Supprimer l'offre",
  '',
  'Tapez le numéro correspondant, ou *Menu* pour revenir.',
].join('\n');

const DELETE_CONFIRM_PROMPT = (title: string) =>
  [
    `*Supprimer l'offre "${title}" ?*`,
    '',
    'Cette action est irréversible.',
    '',
    '1- Oui, supprimer',
    '2- Non, annuler',
  ].join('\n');

function isMenuCommand(normalized: string): boolean {
  return CMD_MENU.includes(normalized) || normalized === 'm';
}

export async function runPostCancellationActionsFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: PostCancellationActionsContext,
): Promise<PostCancellationFlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();
  const payload = (state.payload ?? {}) as Payload;
  const jobOfferId = payload.jobOfferId;

  if (isMenuCommand(normalized)) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  if (!jobOfferId) {
    return { reply: [menuMessage(profile.profile_type)], clearState: true };
  }

  // Step: awaiting delete confirmation
  if (payload.awaitingDeleteConfirm) {
    if (trimmed === '1') {
      try {
        // Soft-cancel (status → CANCELLED). We never hard-delete to keep
        // accounting / penalty / audit history intact.
        await ctx.prisma.jobOffer.updateMany({
          where: { id: jobOfferId, employer_id: profile.id },
          data: { status: JobOfferStatus.CANCELLED },
        });
        return {
          reply: [
            `✅ L'offre *"${payload.jobOfferTitle ?? ''}"* a été supprimée.\n\nTapez *Menu* pour revenir.`,
          ],
          clearState: true,
        };
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Erreur lors de la suppression.';
        return {
          reply: [`❌ ${message} Tapez *Menu* pour revenir.`],
          clearState: true,
        };
      }
    }
    if (trimmed === '2') {
      return {
        reply: ['Suppression annulée.', ACTIONS_PROMPT],
        nextState: {
          ...state,
          payload: { ...payload, awaitingDeleteConfirm: false },
          updatedAt: new Date().toISOString(),
        },
      };
    }
    return {
      reply: [DELETE_CONFIRM_PROMPT(payload.jobOfferTitle ?? '')],
      nextState: state,
    };
  }

  // Step: top-level action picker
  if (trimmed === '1') {
    return {
      reply: [],
      clearState: true,
      handoff: { type: 'candidatures', jobOfferId },
    };
  }

  if (trimmed === '2') {
    return {
      reply: [DELETE_CONFIRM_PROMPT(payload.jobOfferTitle ?? '')],
      nextState: {
        ...state,
        payload: { ...payload, awaitingDeleteConfirm: true },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  // Unknown input — re-show the menu.
  return { reply: [ACTIONS_PROMPT], nextState: state };
}
