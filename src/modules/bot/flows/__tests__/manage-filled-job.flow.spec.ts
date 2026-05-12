import {
  runManageFilledJobFlow,
  getManageFilledJobInitialState,
} from '../manage-filled-job.flow';
import type { BotProfile } from '../../types/bot-state.types';
import type { FilledJobListItem } from '../../messages/application.messages';
import { FLOW_IDS } from '../../bot.constants';

const employerProfile: BotProfile = {
  id: 'e-1',
  first_name: 'Jean',
  last_name: 'Patron',
  phone: '+24200000002',
  email: 'jean@example.com',
  profile_type: 'EMPLOYER',
  reliability_score: null,
  status: 'ACTIVE',
};

function makeItem(id = 'app-1'): FilledJobListItem {
  return {
    applicationId: id,
    title: 'Plombier',
    workerName: 'Alice Dupont',
    scheduled_at: new Date('2026-06-01'),
    amount: 15000,
    payment_flow: 'DAILY',
  };
}

function makeCtx() {
  return {
    applicationService: {
      markJobCompleted: jest
        .fn()
        .mockResolvedValue({ job_offer: { amount: 15000 } }),
      cancelAcceptedByEmployer: jest.fn().mockResolvedValue(undefined),
    } as any,
    notificationService: {
      sendJobCompletedToWorker: jest.fn().mockResolvedValue(undefined),
      sendJobCancelledByEmployerToWorker: jest
        .fn()
        .mockResolvedValue(undefined),
    } as any,
  };
}

describe('runManageFilledJobFlow()', () => {
  it('returns no-items message when items is empty', async () => {
    const state = getManageFilledJobInitialState([]);
    const result = await runManageFilledJobFlow(
      state,
      '',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('AUCUNE');
  });

  it('exits to menu on "menu"', async () => {
    const state = getManageFilledJobInitialState([makeItem()]);
    const result = await runManageFilledJobFlow(
      state,
      'menu',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
  });

  it('exits to menu on "7"', async () => {
    const state = getManageFilledJobInitialState([makeItem()]);
    const result = await runManageFilledJobFlow(
      state,
      '7',
      employerProfile,
      makeCtx(),
    );
    expect(result.clearState).toBe(true);
  });

  it('shows detail on selecting "1"', async () => {
    const state = getManageFilledJobInitialState([makeItem()]);
    const result = await runManageFilledJobFlow(
      state,
      '1',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState?.payload?.step).toBe('detail');
    expect(result.nextState?.payload?.selectedItem).toBeDefined();
  });

  it('shows error for out-of-range selection', async () => {
    const state = getManageFilledJobInitialState([makeItem()]);
    const result = await runManageFilledJobFlow(
      state,
      '9',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState).toBe(state);
    expect(result.reply[0]).toContain('TAPEZ');
  });

  it('paginates on "6" when more items', async () => {
    const items = Array.from({ length: 7 }, (_, i) => makeItem(`app-${i}`));
    const state = getManageFilledJobInitialState(items);
    const result = await runManageFilledJobFlow(
      state,
      '6',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState?.payload?.pageIndex).toBe(1);
  });

  it('shows error when "6" but no more pages', async () => {
    const state = getManageFilledJobInitialState([makeItem()]);
    const result = await runManageFilledJobFlow(
      state,
      '6',
      employerProfile,
      makeCtx(),
    );
    expect(result.nextState).toBe(state);
  });

  describe('detail step', () => {
    function makeDetailState(item: FilledJobListItem) {
      return {
        flowId: FLOW_IDS.MANAGE_FILLED_JOB,
        step: 1,
        payload: {
          items: [item],
          pageIndex: 0,
          step: 'detail',
          selectedItem: item,
        },
        updatedAt: new Date().toISOString(),
      };
    }

    it('exits to menu on "4"', async () => {
      const state = makeDetailState(makeItem());
      const result = await runManageFilledJobFlow(
        state,
        '4',
        employerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('returns to list on "3"', async () => {
      const state = makeDetailState(makeItem());
      const result = await runManageFilledJobFlow(
        state,
        '3',
        employerProfile,
        makeCtx(),
      );
      expect(result.nextState?.payload?.step).toBe('list');
    });

    it('transitions to note step on "1"', async () => {
      const ctx = makeCtx();
      const state = makeDetailState(makeItem());
      const result = await runManageFilledJobFlow(
        state,
        '1',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.payload?.step).toBe('note');
      expect(result.reply[0]).toContain('Laissez une note');
    });

    it('shows cancel confirmation on "2"', async () => {
      const ctx = makeCtx();
      const state = makeDetailState(makeItem());
      const result = await runManageFilledJobFlow(
        state,
        '2',
        employerProfile,
        ctx,
      );
      expect(result.nextState?.payload?.step).toBe('cancel_confirm');
      expect(result.reply[0]).toContain('annuler');
    });

    it('cancels accepted job after confirming on "1" in cancel_confirm step', async () => {
      const ctx = makeCtx();
      const item = makeItem();
      const state = {
        flowId: FLOW_IDS.MANAGE_FILLED_JOB,
        step: 1,
        payload: { items: [item], pageIndex: 0, step: 'cancel_confirm', selectedItem: item },
        updatedAt: new Date().toISOString(),
      };
      const result = await runManageFilledJobFlow(state, '1', employerProfile, ctx);
      expect(ctx.applicationService.cancelAcceptedByEmployer).toHaveBeenCalledWith('app-1', 'e-1');
      expect(result.clearState).toBe(true);
    });

    it('returns error when cancelAcceptedByEmployer throws', async () => {
      const ctx = makeCtx();
      ctx.applicationService.cancelAcceptedByEmployer.mockRejectedValue(
        new Error('DB error'),
      );
      const item = makeItem();
      const state = {
        flowId: FLOW_IDS.MANAGE_FILLED_JOB,
        step: 1,
        payload: { items: [item], pageIndex: 0, step: 'cancel_confirm', selectedItem: item },
        updatedAt: new Date().toISOString(),
      };
      const result = await runManageFilledJobFlow(state, '1', employerProfile, ctx);
      expect(result.reply[0]).toContain('DB error');
    });

    it('shows detail again for unknown input', async () => {
      const state = makeDetailState(makeItem());
      const result = await runManageFilledJobFlow(
        state,
        'xyz',
        employerProfile,
        makeCtx(),
      );
      expect(result.nextState).toBe(state);
    });
  });
});

describe('getManageFilledJobInitialState()', () => {
  it('creates state with correct flowId', () => {
    const items = [makeItem()];
    const state = getManageFilledJobInitialState(items);
    expect(state.flowId).toBe(FLOW_IDS.MANAGE_FILLED_JOB);
    expect(state.payload?.items).toBe(items);
  });
});
