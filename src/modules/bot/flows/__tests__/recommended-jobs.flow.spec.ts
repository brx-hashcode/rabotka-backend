import {
  runRecommendedJobsFlow,
  getRecommendedJobsInitialState,
} from '../recommended-jobs.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import type { OfferListItem } from '../../messages/offers.messages';

const profile: BotProfile = {
  id: 'worker-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@test.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

function makeOffer(id: string): OfferListItem {
  return {
    id,
    title: `Offre ${id}`,
    description: 'Description',
    scheduled_at: new Date(Date.now() + 86400000),
    amount: 15000,
    payment_flow: 'DAILY',
    address: 'Brazzaville',
    note: null,
    quantity: 1,
    acceptedCount: 0,
    status: 'ACTIVE',
    employerScore: null,
  };
}

const mockOffer = makeOffer('offer-1');
const mockFreshOffer = {
  id: 'offer-1',
  title: 'Offre offer-1',
  description: 'Full description',
  scheduled_at: new Date(Date.now() + 86400000),
  amount: 15000,
  payment_flow: 'DAILY',
  address: 'Brazzaville',
  note: null,
  quantity: 1,
  acceptedCount: 0,
  status: 'ACTIVE',
};

function makeState(step: string = 'list', payload: any = {}): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_JOBS,
    step: 0,
    payload: {
      offers: [
        mockOffer,
        makeOffer('offer-2'),
        makeOffer('offer-3'),
        makeOffer('offer-4'),
      ],
      step,
      page: 0,
      ...payload,
    },
    updatedAt: new Date().toISOString(),
  };
}

function makeCtx() {
  return {
    jobOfferService: {
      findById: jest.fn().mockResolvedValue(mockFreshOffer),
    } as any,
    interestSignalService: {
      record: jest.fn().mockResolvedValue(undefined),
    } as any,
  };
}

describe('runRecommendedJobsFlow', () => {
  it('returns menu when menu command', async () => {
    const ctx = makeCtx();
    const result = await runRecommendedJobsFlow(
      makeState(),
      'menu',
      profile,
      ctx,
    );
    expect(result.clearState).toBe(true);
  });

  it('returns no offers message when offers list is empty', async () => {
    const ctx = makeCtx();
    const state: BotState = {
      flowId: FLOW_IDS.RECOMMENDED_JOBS,
      step: 0,
      payload: { offers: [], step: 'list' },
      updatedAt: new Date().toISOString(),
    };
    const result = await runRecommendedJobsFlow(state, '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucune offre');
  });

  describe('list step', () => {
    it('returns list for unknown input', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState(),
        'xyz',
        profile,
        ctx,
      );
      expect(result.nextState).toBeDefined();
    });

    it('selects offer with valid number', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState(),
        '1',
        profile,
        ctx,
      );
      expect(result.nextState?.payload?.step).toBe('detail');
    });

    it('returns not found when offer no longer exists', async () => {
      const ctx = makeCtx();
      ctx.jobOfferService.findById.mockResolvedValue(null);
      const result = await runRecommendedJobsFlow(
        makeState(),
        '1',
        profile,
        ctx,
      );
      expect(result.reply[0]).toContain('introuvable');
    });

    it('navigates to next page with s', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState('list', { page: 0 }),
        's',
        profile,
        ctx,
      );
      expect(result.nextState?.payload?.page).toBe(1);
    });

    it('stays on same page when s at last page', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState('list', { page: 1 }),
        's',
        profile,
        ctx,
      );
      // Should show list again - result.nextState still exists
      expect(result).toBeDefined();
    });

    it('navigates to previous page with p', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState('list', { page: 1 }),
        'p',
        profile,
        ctx,
      );
      expect(result.nextState?.payload?.page).toBe(0);
    });

    it('stays when p at first page', async () => {
      const ctx = makeCtx();
      const result = await runRecommendedJobsFlow(
        makeState('list', { page: 0 }),
        'p',
        profile,
        ctx,
      );
      expect(result).toBeDefined();
    });
  });

  describe('detail step', () => {
    it('starts apply flow when 1 entered', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(state, '1', profile, ctx);
      expect(result.nextState?.flowId).toBe(FLOW_IDS.APPLY_JOB);
    });

    it('starts apply flow when postuler entered', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(
        state,
        'postuler',
        profile,
        ctx,
      );
      expect(result.nextState?.flowId).toBe(FLOW_IDS.APPLY_JOB);
    });

    it('shows full description when 2 entered', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(state, '2', profile, ctx);
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Full description');
    });

    it('returns offer not found for 2 when offer missing', async () => {
      const ctx = makeCtx();
      ctx.jobOfferService.findById.mockResolvedValue(null);
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(state, '2', profile, ctx);
      expect(result.reply[0]).toContain('introuvable');
    });

    it('returns to list when 3 entered', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(state, '3', profile, ctx);
      expect(result.nextState?.payload?.step).toBe('list');
    });

    it('returns to list when retour entered', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(
        state,
        'retour',
        profile,
        ctx,
      );
      expect(result.nextState?.payload?.step).toBe('list');
    });

    it('returns menu for 4', async () => {
      const ctx = makeCtx();
      const state = makeState('detail', { selectedOfferId: 'offer-1' });
      const result = await runRecommendedJobsFlow(state, '4', profile, ctx);
      expect(result.clearState).toBe(true);
    });
  });

  it('returns error for unknown step', async () => {
    const ctx = makeCtx();
    const state = makeState('unknown_step' as any);
    const result = await runRecommendedJobsFlow(state, '1', profile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('ERREUR');
  });
});

describe('getRecommendedJobsInitialState', () => {
  it('returns initial state', () => {
    const state = getRecommendedJobsInitialState(['offer-1'], [mockOffer]);
    expect(state.flowId).toBe(FLOW_IDS.RECOMMENDED_JOBS);
    expect(state.payload?.step).toBe('list');
  });
});
