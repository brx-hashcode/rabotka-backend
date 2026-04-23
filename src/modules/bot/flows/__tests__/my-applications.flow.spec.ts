import {
  runMyApplicationsFlow,
  getMyApplicationsInitialState,
} from '../my-applications.flow';
import type { BotProfile } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';

const workerProfile: BotProfile = {
  id: 'w-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

function makeApp(status = 'PENDING') {
  return {
    id: 'app-1',
    status,
    worker_id: 'w-1',
    job_offer: {
      id: 'jo-1',
      title: 'Plombier',
      scheduled_at: new Date('2026-06-01'),
      amount: 15000,
      payment_flow: 'DAILY',
      address: '10 Rue Paris',
      status: 'ACTIVE',
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    applicationService: {
      findByWorker: jest.fn().mockResolvedValue([makeApp()]),
      findByEmployer: jest.fn().mockResolvedValue([makeApp()]),
      findById: jest.fn().mockResolvedValue(makeApp()),
      cancel: jest.fn().mockResolvedValue({ penaltyAmount: null }),
      ...overrides,
    },
    notificationService: {
      sendCancellationToEmployer: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
    },
    contactUnlockService: {
      getByApplicationId: jest.fn().mockResolvedValue(null),
      rejectPendingAttemptByApplication: jest.fn(),
    },
    walletService: {},
    paymentService: {},
    systemConfigService: {
      getContactUnlockFees: jest.fn().mockResolvedValue({
        employerFeeFcfa: 1000,
        workerFeeFcfa: 500,
        expiryHours: 24,
      }),
    },
    ...overrides,
  } as any;
}

function makeState(applicationIds: string[], step = 0) {
  return {
    flowId: FLOW_IDS.MY_APPLICATIONS,
    step,
    payload: { applicationIds },
    updatedAt: new Date().toISOString(),
  };
}

describe('runMyApplicationsFlow()', () => {
  it('exits to menu on "menu" input', async () => {
    const ctx = makeCtx();
    const state = makeState(['app-1']);
    const result = await runMyApplicationsFlow(state, 'menu', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toMatch(/MENU/i);
  });

  it('returns error when no applicationIds', async () => {
    const ctx = makeCtx();
    const state = makeState([]);
    const result = await runMyApplicationsFlow(state, '', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('AUCUNE CANDIDATURE');
  });

  describe('step 0 — select application', () => {
    it('shows list when input is not a valid number', async () => {
      const ctx = makeCtx();
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(state, 'abc', workerProfile, ctx);
      expect(result.reply).toBeDefined();
    });

    it('shows application detail when valid index selected', async () => {
      const ctx = makeCtx();
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(state, '1', workerProfile, ctx);
      expect(result.nextState?.step).toBe(1);
    });

    it('returns not-found when application belongs to different worker', async () => {
      const ctx = makeCtx({
        findById: jest.fn().mockResolvedValue({ ...makeApp(), worker_id: 'other' }),
      });
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });
  });

  describe('step 1 — application detail', () => {
    function makeStep1State(applicationId: string, selectedIndex = 0) {
      return {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: [applicationId], selectedIndex },
        updatedAt: new Date().toISOString(),
      };
    }

    it('initiates cancellation on "1" for PENDING application', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(state, '1', workerProfile, ctx);
      // Should transition to cancel flow
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns to list on "2" for cancellable app', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(state, '2', workerProfile, ctx);
      expect(result.reply).toBeDefined();
    });

    it('returns to menu on "3" for cancellable app', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(state, '3', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('shows detail again for unrecognized input', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(state, 'xyz', workerProfile, ctx);
      expect(result.nextState).toBe(state);
    });

    it('returns index error when no selectedIndex', async () => {
      const ctx = makeCtx();
      const state = {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: ['app-1'] },
        updatedAt: new Date().toISOString(),
      };
      const result = await runMyApplicationsFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });
  });

  describe('getMyApplicationsInitialState()', () => {
    it('returns correct initial state', () => {
      const state = getMyApplicationsInitialState(['app-1', 'app-2']);
      expect(state.flowId).toBe(FLOW_IDS.MY_APPLICATIONS);
      expect(state.step).toBe(0);
      expect(state.payload?.applicationIds).toEqual(['app-1', 'app-2']);
      expect(state.payload?.listMode).toBe('all');
    });

    it('sets pending_payments list mode when requested', () => {
      const state = getMyApplicationsInitialState(['app-1'], 'pending_payments');
      expect(state.payload?.listMode).toBe('pending_payments');
    });
  });

  describe('step 0 — multi-digit index', () => {
    it('selects the 10th application when user types 10', async () => {
      const ids = Array.from({ length: 10 }, (_, i) => `app-${i + 1}`);
      const ctx = makeCtx({
        findById: jest.fn().mockResolvedValue({ ...makeApp(), id: 'app-10' }),
      });
      const state = {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 0,
        payload: { applicationIds: ids },
        updatedAt: new Date().toISOString(),
      };
      const result = await runMyApplicationsFlow(state, '10', workerProfile, ctx);
      expect(result.nextState?.step).toBe(1);
      expect(ctx.applicationService.findById).toHaveBeenCalledWith('app-10');
    });
  });
});
