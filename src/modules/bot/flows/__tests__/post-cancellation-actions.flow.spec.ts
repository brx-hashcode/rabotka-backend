import { runPostCancellationActionsFlow } from '../post-cancellation-actions.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { JobOfferStatus } from '@prisma/client';

const employer: BotProfile = {
  id: 'emp-1',
  first_name: 'Marie',
  last_name: 'Patron',
  phone: '+242000010',
  email: 'marie@example.com',
  profile_type: 'EMPLOYER',
  reliability_score: 95,
  status: 'ACTIVE',
};

function makeState(payload: Record<string, unknown> = {}, step = 0): BotState {
  return {
    flowId: FLOW_IDS.POST_CANCELLATION_ACTIONS,
    step,
    payload: {
      jobOfferId: 'jo-1',
      jobOfferTitle: 'Plombier urgent',
      ...payload,
    },
    updatedAt: new Date().toISOString(),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    prisma: {
      jobOffer: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any,
    ...overrides,
  };
}

describe('runPostCancellationActionsFlow', () => {
  describe('global commands', () => {
    it('returns menu on "menu" command', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        'menu',
        employer,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toBeDefined();
    });

    it('returns menu on "m" shortcut', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        'm',
        employer,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('returns menu when jobOfferId is missing from payload', async () => {
      // Edge case — state was tampered or lost mid-flow
      const result = await runPostCancellationActionsFlow(
        makeState({ jobOfferId: undefined }),
        '1',
        employer,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });
  });

  describe('top-level action picker', () => {
    it('signals candidatures hand-off on "1"', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        '1',
        employer,
        makeCtx(),
      );
      expect(result.handoff).toEqual({
        type: 'candidatures',
        jobOfferId: 'jo-1',
      });
      expect(result.clearState).toBe(true);
    });

    it('moves to confirm step on "2" (delete)', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        '2',
        employer,
        makeCtx(),
      );
      expect(result.nextState?.payload.awaitingDeleteConfirm).toBe(true);
      expect(result.reply[0]).toContain('Supprimer');
      expect(result.reply[0]).toContain('Plombier urgent');
    });

    it('re-shows the menu on unrecognised input', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        'xyz',
        employer,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('Actions disponibles');
      expect(result.nextState).toBeDefined();
      expect(result.handoff).toBeUndefined();
    });

    it('re-shows the menu on numeric input outside 1–2', async () => {
      const result = await runPostCancellationActionsFlow(
        makeState(),
        '9',
        employer,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('Actions disponibles');
    });
  });

  describe('delete confirmation', () => {
    it('soft-cancels the offer on "1" (Oui)', async () => {
      const ctx = makeCtx();
      const result = await runPostCancellationActionsFlow(
        makeState({ awaitingDeleteConfirm: true }),
        '1',
        employer,
        ctx,
      );
      expect(ctx.prisma.jobOffer.updateMany).toHaveBeenCalledWith({
        where: { id: 'jo-1', employer_id: 'emp-1' },
        data: { status: JobOfferStatus.CANCELLED },
      });
      expect(result.reply[0]).toContain('a été supprimée');
      expect(result.reply[0]).toContain('Plombier urgent');
      expect(result.clearState).toBe(true);
    });

    it('reports a friendly error if the delete throws', async () => {
      const ctx = makeCtx({
        prisma: {
          jobOffer: {
            updateMany: jest.fn().mockRejectedValueOnce(new Error('DB down')),
          },
        },
      });
      const result = await runPostCancellationActionsFlow(
        makeState({ awaitingDeleteConfirm: true }),
        '1',
        employer,
        ctx,
      );
      expect(result.reply[0]).toContain('DB down');
      expect(result.clearState).toBe(true);
    });

    it('reports a generic error message for non-Error rejections', async () => {
      const ctx = makeCtx({
        prisma: {
          jobOffer: {
            updateMany: jest.fn().mockRejectedValueOnce('not-an-error'),
          },
        },
      });
      const result = await runPostCancellationActionsFlow(
        makeState({ awaitingDeleteConfirm: true }),
        '1',
        employer,
        ctx,
      );
      expect(result.reply[0]).toContain('Erreur lors de la suppression');
      expect(result.clearState).toBe(true);
    });

    it('cancels deletion and returns to the menu on "2" (Non)', async () => {
      const ctx = makeCtx();
      const result = await runPostCancellationActionsFlow(
        makeState({ awaitingDeleteConfirm: true }),
        '2',
        employer,
        ctx,
      );
      expect(ctx.prisma.jobOffer.updateMany).not.toHaveBeenCalled();
      expect(result.reply[0]).toContain('Suppression annulée');
      expect(result.reply[1]).toContain('Actions disponibles');
      expect(result.nextState?.payload.awaitingDeleteConfirm).toBe(false);
    });

    it('re-shows the confirmation prompt on unrecognised input', async () => {
      const ctx = makeCtx();
      const result = await runPostCancellationActionsFlow(
        makeState({ awaitingDeleteConfirm: true }),
        'oui',
        employer,
        ctx,
      );
      expect(ctx.prisma.jobOffer.updateMany).not.toHaveBeenCalled();
      expect(result.reply[0]).toContain('Supprimer');
      expect(result.nextState).toBeDefined();
    });
  });
});
