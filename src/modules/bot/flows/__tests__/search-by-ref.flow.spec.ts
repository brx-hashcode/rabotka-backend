import {
  runSearchByRefFlow,
  getSearchByRefInitialState,
  getSearchByRefPromptMessage,
} from '../search-by-ref.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { workerMenuMessage } from '../../messages/menu.messages';

const workerProfile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  email: 'alice@example.com',
  phone: '+242001',
  profile_type: 'WORKER',
  reliability_score: 90,
};

const employerProfile: BotProfile = {
  ...workerProfile,
  id: 'employer-1',
  profile_type: 'EMPLOYER',
};

const baseOffer = {
  id: 'offer-1',
  title: 'Plombier',
  description: 'Travaux plomberie',
  address: '10 Rue Brazza',
  amount: 15000,
  payment_flow: 'DAILY' as const,
  scheduled_at: new Date('2026-07-01T08:00:00Z'),
  note: null as string | null,
  quantity: 2,
  acceptedCount: 0,
  status: 'ACTIVE',
  reference: 'RBT-ABC12',
  employer: null,
  employerScore: null,
};

function makeCtx(
  overrides: Partial<{ jobOfferService: any; systemConfigService: any }> = {},
) {
  return {
    jobOfferService: {
      findByReference: jest.fn().mockResolvedValue(baseOffer),
      findById: jest.fn().mockResolvedValue(baseOffer),
      ...overrides.jobOfferService,
    },
    systemConfigService: {
      getFees: jest.fn().mockResolvedValue({
        lateCancellationPenaltyFcfa: 5000,
        cancellationThresholdHours: 24,
      }),
      ...overrides.systemConfigService,
    },
  };
}

function refState(): BotState {
  return getSearchByRefInitialState();
}

function detailState(offerId = 'offer-1'): BotState {
  return {
    flowId: FLOW_IDS.SEARCH_BY_REF,
    step: 0,
    payload: { step: 'detail', offerId },
    updatedAt: new Date().toISOString(),
  };
}

function descriptionState(offerId = 'offer-1'): BotState {
  return {
    flowId: FLOW_IDS.SEARCH_BY_REF,
    step: 0,
    payload: { step: 'description', offerId },
    updatedAt: new Date().toISOString(),
  };
}

describe('getSearchByRefInitialState()', () => {
  it('returns SEARCH_BY_REF flow at step ref', () => {
    const state = getSearchByRefInitialState();
    expect(state.flowId).toBe(FLOW_IDS.SEARCH_BY_REF);
    expect(state.payload?.step).toBe('ref');
  });
});

describe('getSearchByRefPromptMessage()', () => {
  it('contains the reference example', () => {
    expect(getSearchByRefPromptMessage()).toContain('RBT-7K3X9');
  });
});

describe('runSearchByRefFlow()', () => {
  describe('menu command', () => {
    it('exits on "menu" regardless of step', async () => {
      const ctx = makeCtx();
      const result = await runSearchByRefFlow(
        refState(),
        'menu',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toBe(workerMenuMessage());
    });

    it('exits on "Menu" (capitalized)', async () => {
      const result = await runSearchByRefFlow(
        refState(),
        'Menu',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });
  });

  describe('employer guard', () => {
    it('rejects employer profile immediately', async () => {
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-ABC12',
        employerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('travailleurs');
    });
  });

  describe('ref step', () => {
    it('shows prompt again on empty input', async () => {
      const result = await runSearchByRefFlow(
        refState(),
        '  ',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('référence');
      expect(result.clearState).toBeUndefined();
    });

    it('returns offer detail card when offer is found', async () => {
      const ctx = makeCtx();
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-ABC12',
        workerProfile,
        ctx,
      );
      expect(ctx.jobOfferService.findByReference).toHaveBeenCalled();
      expect(result.reply[0]).toBeTruthy();
      expect(result.nextState?.payload?.step).toBe('detail');
      expect(result.nextState?.payload?.offerId).toBe('offer-1');
    });

    it('reports not found when offer is null', async () => {
      const ctx = makeCtx({
        jobOfferService: { findByReference: jest.fn().mockResolvedValue(null) },
      });
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-XXXXX',
        workerProfile,
        ctx,
      );
      expect(result.reply[0]).toContain('Aucune offre trouvée');
      expect(result.nextState?.payload?.step).toBe('ref');
    });

    it('rejects offer with non-active status', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest
            .fn()
            .mockResolvedValue({ ...baseOffer, status: 'COMPLETED' }),
        },
      });
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-ABC12',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('plus disponible');
    });

    it('rejects offer with PARTIALLY_FILLED status that is full', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest.fn().mockResolvedValue({
            ...baseOffer,
            status: 'PARTIALLY_FILLED',
            quantity: 2,
            acceptedCount: 2,
          }),
        },
      });
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-ABC12',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('complète');
    });

    it('accepts PARTIALLY_FILLED offer with remaining slots', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest.fn().mockResolvedValue({
            ...baseOffer,
            status: 'PARTIALLY_FILLED',
            quantity: 2,
            acceptedCount: 1,
          }),
        },
      });
      const result = await runSearchByRefFlow(
        refState(),
        'RBT-ABC12',
        workerProfile,
        ctx,
      );
      expect(result.nextState?.payload?.step).toBe('detail');
    });
  });

  describe('detail step', () => {
    it('falls back to ref prompt when offerId is missing', async () => {
      const state: BotState = {
        flowId: FLOW_IDS.SEARCH_BY_REF,
        step: 0,
        payload: { step: 'detail' },
        updatedAt: new Date().toISOString(),
      };
      const result = await runSearchByRefFlow(
        state,
        '1',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('référence');
    });

    it('1 — starts apply confirmation for worker', async () => {
      const result = await runSearchByRefFlow(
        detailState(),
        '1',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('postuler');
      expect(result.nextState?.flowId).toBe(FLOW_IDS.APPLY_JOB);
    });

    it('1 — rejects employer trying to apply', async () => {
      const state: BotState = {
        flowId: FLOW_IDS.SEARCH_BY_REF,
        step: 0,
        payload: { step: 'detail', offerId: 'offer-1' },
        updatedAt: new Date().toISOString(),
      };
      const result = await runSearchByRefFlow(
        state,
        '1',
        employerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('travailleurs');
      expect(result.clearState).toBe(true);
    });

    it('1 — handles offer not found during apply', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest.fn(),
          findById: jest.fn().mockResolvedValue(null),
        },
      });
      const result = await runSearchByRefFlow(
        detailState(),
        '1',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('2 — shows description', async () => {
      const result = await runSearchByRefFlow(
        detailState(),
        '2',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('Plombier');
      expect(result.nextState?.payload?.step).toBe('description');
    });

    it('2 — handles offer not found for description', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest.fn(),
          findById: jest.fn().mockResolvedValue(null),
        },
      });
      const result = await runSearchByRefFlow(
        detailState(),
        '2',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('3 — goes back to ref prompt', async () => {
      const result = await runSearchByRefFlow(
        detailState(),
        '3',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('référence');
      expect(result.nextState?.payload?.step).toBe('ref');
    });

    it('4 — exits to menu', async () => {
      const result = await runSearchByRefFlow(
        detailState(),
        '4',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('unknown input — re-prompts', async () => {
      const result = await runSearchByRefFlow(
        detailState(),
        'xyz',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('Répondez par');
      expect(result.nextState?.payload?.step).toBe('detail');
    });
  });

  describe('description step', () => {
    it('falls back to ref prompt when offerId is missing', async () => {
      const state: BotState = {
        flowId: FLOW_IDS.SEARCH_BY_REF,
        step: 0,
        payload: { step: 'description' },
        updatedAt: new Date().toISOString(),
      };
      const result = await runSearchByRefFlow(
        state,
        '1',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('référence');
    });

    it('1 — starts apply confirmation', async () => {
      const result = await runSearchByRefFlow(
        descriptionState(),
        '1',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('postuler');
      expect(result.nextState?.flowId).toBe(FLOW_IDS.APPLY_JOB);
    });

    it('2 — returns to detail card', async () => {
      const result = await runSearchByRefFlow(
        descriptionState(),
        '2',
        workerProfile,
        makeCtx(),
      );
      expect(result.nextState?.payload?.step).toBe('detail');
    });

    it('2 — handles offer not found', async () => {
      const ctx = makeCtx({
        jobOfferService: {
          findByReference: jest.fn(),
          findById: jest.fn().mockResolvedValue(null),
        },
      });
      const result = await runSearchByRefFlow(
        descriptionState(),
        '2',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('3 — exits to menu', async () => {
      const result = await runSearchByRefFlow(
        descriptionState(),
        '3',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('"menu" command — exits to menu', async () => {
      const result = await runSearchByRefFlow(
        descriptionState(),
        'menu',
        workerProfile,
        makeCtx(),
      );
      expect(result.clearState).toBe(true);
    });

    it('unknown input — re-prompts', async () => {
      const result = await runSearchByRefFlow(
        descriptionState(),
        'xyz',
        workerProfile,
        makeCtx(),
      );
      expect(result.reply[0]).toContain('Répondez par');
      expect(result.nextState?.payload?.step).toBe('description');
    });
  });
});
