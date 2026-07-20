import {
  runMyApplicationsFlow,
  getMyApplicationsInitialState,
} from '../my-applications.flow';
import type { BotProfile } from '../../types/bot-state.types';
import { FLOW_IDS } from '../../bot.constants';
import { workerMenuMessage } from '../../messages/menu.messages';

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

// findByWorker / findByEmployer are overloaded: legacy {limit} returns
// an array, new {page, pageSize} returns {items, total}. This adapter
// returns the right shape for whichever path the caller used.
function adaptList(rows: unknown[]) {
  return jest
    .fn()
    .mockImplementation((_id: string, opts?: { page?: number }) =>
      opts && opts.page !== undefined
        ? Promise.resolve({ items: rows, total: rows.length })
        : Promise.resolve(rows),
    );
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    applicationService: {
      findByWorker: adaptList([makeApp()]),
      findByEmployer: adaptList([makeApp()]),
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
    walletService: {
      getProfileWalletBalance: jest.fn().mockResolvedValue(5000),
    },
    paymentService: {
      createPaymentUrl: jest.fn().mockResolvedValue('http://pay.url'),
    },
    systemConfigService: {
      getContactUnlockFees: jest.fn().mockResolvedValue({
        employerFeeFcfa: 1000,
        workerFeeFcfa: 500,
        expiryHours: 24,
      }),
      getFees: jest.fn().mockResolvedValue({
        cancellationThresholdHours: 4,
        lateCancellationPenaltyFcfa: 5000,
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
    const result = await runMyApplicationsFlow(
      state,
      'menu',
      workerProfile,
      ctx,
    );
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toBe(workerMenuMessage());
  });

  it('returns error when no applicationIds', async () => {
    const ctx = makeCtx();
    const state = makeState([]);
    const result = await runMyApplicationsFlow(state, '', workerProfile, ctx);
    expect(result.clearState).toBe(true);
    expect(result.reply[0]).toContain('Aucune candidature');
  });

  describe('step 0 — select application', () => {
    it('shows list when input is not a valid number', async () => {
      const ctx = makeCtx();
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(
        state,
        'abc',
        workerProfile,
        ctx,
      );
      expect(result.reply).toBeDefined();
    });

    it('shows application detail when valid index selected', async () => {
      const ctx = makeCtx();
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
    });

    it('returns not-found when application belongs to different worker', async () => {
      const ctx = makeCtx({
        findById: jest
          .fn()
          .mockResolvedValue({ ...makeApp(), worker_id: 'other' }),
      });
      const state = makeState(['app-1'], 0);
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
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
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      // Should transition to cancel flow
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns to list on "2" for cancellable app', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '2',
        workerProfile,
        ctx,
      );
      expect(result.reply).toBeDefined();
    });

    it('returns to menu on "3" for cancellable app', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '3',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('shows detail again for unrecognized input', async () => {
      const ctx = makeCtx();
      const state = makeStep1State('app-1');
      const result = await runMyApplicationsFlow(
        state,
        'xyz',
        workerProfile,
        ctx,
      );
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
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
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
      const state = getMyApplicationsInitialState(
        ['app-1'],
        'pending_payments',
      );
      expect(state.payload?.listMode).toBe('pending_payments');
    });
  });

  describe('step 1 — WAITING_PAYMENT application', () => {
    function makeWaitingPaymentApp() {
      return {
        id: 'app-1',
        status: 'WAITING_PAYMENT',
        worker_id: 'w-1',
        job_offer: {
          id: 'jo-1',
          title: 'Plombier',
          scheduled_at: new Date('2026-06-01'),
          amount: 15000,
          payment_flow: 'DAILY',
          address: '10 Rue Paris',
          status: 'ACTIVE',
          employer_id: 'emp-1',
          employer: { first_name: 'Jean', last_name: 'Patron' },
        },
        worker: { first_name: 'Alice', last_name: 'Dupont' },
      };
    }

    function makeStep1StateWP(applicationId: string) {
      return {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: [applicationId], selectedIndex: 0 },
        updatedAt: new Date().toISOString(),
      };
    }

    it('initiates payment on "1" for WAITING_PAYMENT application', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeWaitingPaymentApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeWaitingPaymentApp()),
          cancel: jest.fn(),
        },
        contactUnlockService: {
          getByApplicationId: jest.fn().mockResolvedValue({
            id: 'attempt-1',
            expires_at: new Date(Date.now() + 3600000),
          }),
          rejectPendingAttemptByApplication: jest.fn(),
        },
      });
      const state = makeStep1StateWP('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns early when no unlock attempt for WAITING_PAYMENT on "1"', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeWaitingPaymentApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeWaitingPaymentApp()),
          cancel: jest.fn(),
        },
        contactUnlockService: {
          getByApplicationId: jest.fn().mockResolvedValue(null),
          rejectPendingAttemptByApplication: jest.fn(),
        },
      });
      const state = makeStep1StateWP('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });

    it('rejects on "2" for WAITING_PAYMENT', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeWaitingPaymentApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeWaitingPaymentApp()),
          cancel: jest.fn(),
        },
        contactUnlockService: {
          getByApplicationId: jest.fn().mockResolvedValue(null),
          rejectPendingAttemptByApplication: jest.fn().mockResolvedValue({
            otherPhone: '+242',
            otherPartyMessage: 'cancelled',
            currentPartyMessage: 'done',
          }),
        },
      });
      const state = makeStep1StateWP('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '2',
        workerProfile,
        ctx,
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns list on "3" for WAITING_PAYMENT', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeWaitingPaymentApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeWaitingPaymentApp()),
          cancel: jest.fn(),
        },
        contactUnlockService: {
          getByApplicationId: jest.fn().mockResolvedValue(null),
          rejectPendingAttemptByApplication: jest.fn(),
        },
      });
      const state = makeStep1StateWP('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '3',
        workerProfile,
        ctx,
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns menu on "4" for WAITING_PAYMENT', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeWaitingPaymentApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeWaitingPaymentApp()),
          cancel: jest.fn(),
        },
        contactUnlockService: {
          getByApplicationId: jest.fn().mockResolvedValue(null),
          rejectPendingAttemptByApplication: jest.fn(),
        },
      });
      const state = makeStep1StateWP('app-1');
      const result = await runMyApplicationsFlow(
        state,
        '4',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
    });
  });

  describe('step 1 — ACCEPTED application', () => {
    function makeAcceptedApp() {
      return {
        id: 'app-1',
        status: 'ACCEPTED',
        worker_id: 'w-1',
        job_offer: {
          id: 'jo-1',
          title: 'Plombier',
          scheduled_at: new Date('2026-06-01'),
          amount: 15000,
          payment_flow: 'DAILY',
          address: '10 Rue Paris',
          status: 'ACTIVE',
          employer_id: 'emp-1',
          employer: { first_name: 'Jean', last_name: 'Patron' },
        },
        worker: { first_name: 'Alice', last_name: 'Dupont' },
      };
    }

    it('initiates cancellation on "1" for ACCEPTED application', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: jest.fn().mockResolvedValue([makeAcceptedApp()]),
          findByEmployer: jest.fn().mockResolvedValue([]),
          findById: jest.fn().mockResolvedValue(makeAcceptedApp()),
          cancel: jest.fn().mockResolvedValue({ penaltyAmount: null }),
        },
      });
      const state = {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: ['app-1'], selectedIndex: 0 },
        updatedAt: new Date().toISOString(),
      };
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });
  });

  describe('step 1 — read-only application (CANCELLED)', () => {
    function makeCancelledApp() {
      return {
        id: 'app-1',
        status: 'CANCELLED',
        worker_id: 'w-1',
        job_offer: {
          id: 'jo-1',
          title: 'Plombier',
          scheduled_at: new Date('2026-06-01'),
          amount: 15000,
          payment_flow: 'DAILY',
          address: '10 Rue Paris',
          status: 'ACTIVE',
          employer_id: 'emp-1',
          employer: { first_name: 'Jean', last_name: 'Patron' },
        },
        worker: { first_name: 'Alice', last_name: 'Dupont' },
      };
    }

    it('returns list on "1" for CANCELLED application', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: adaptList([makeCancelledApp()]),
          findByEmployer: adaptList([]),
          findById: jest.fn().mockResolvedValue(makeCancelledApp()),
          cancel: jest.fn(),
        },
      });
      const state = {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: ['app-1'], selectedIndex: 0 },
        updatedAt: new Date().toISOString(),
      };
      const result = await runMyApplicationsFlow(
        state,
        '1',
        workerProfile,
        ctx,
      );
      expect(result.reply.length).toBeGreaterThan(0);
    });

    it('returns menu on "2" for CANCELLED application', async () => {
      const ctx = makeCtx({
        applicationService: {
          findByWorker: jest.fn().mockResolvedValue([makeCancelledApp()]),
          findByEmployer: jest.fn().mockResolvedValue([]),
          findById: jest.fn().mockResolvedValue(makeCancelledApp()),
          cancel: jest.fn(),
        },
      });
      const state = {
        flowId: FLOW_IDS.MY_APPLICATIONS,
        step: 1,
        payload: { applicationIds: ['app-1'], selectedIndex: 0 },
        updatedAt: new Date().toISOString(),
      };
      const result = await runMyApplicationsFlow(
        state,
        '2',
        workerProfile,
        ctx,
      );
      expect(result.clearState).toBe(true);
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
      const result = await runMyApplicationsFlow(
        state,
        '10',
        workerProfile,
        ctx,
      );
      expect(result.nextState?.step).toBe(1);
      expect(ctx.applicationService.findById).toHaveBeenCalledWith('app-10');
    });
  });
});
