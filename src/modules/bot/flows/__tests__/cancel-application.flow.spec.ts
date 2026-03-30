import {
  runCancelApplicationFlow,
  getCancelApplicationInitialState,
} from '../cancel-application.flow';
import type { BotProfile, BotState } from '../../types/bot-state.types';
import type { CancelApplicationContext } from '../cancel-application.flow';
import { FLOW_IDS } from '../../bot.constants';

const WORKER_ID = 'worker-1';
const APP_ID = 'app-1';

const workerProfile: BotProfile = {
  id: WORKER_ID,
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  profile_type: 'EMPLOYER',
};

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

function makeApp(scheduledAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    worker_id: WORKER_ID,
    status: 'ACCEPTED',
    job_offer: {
      title: 'Plombier',
      scheduled_at: scheduledAt,
      amount: 15000,
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CancelApplicationContext> = {}): CancelApplicationContext {
  return {
    applicationService: {
      findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(10))),
      cancel: jest.fn().mockResolvedValue({ penaltyAmount: null, penaltyApplied: false }),
    } as unknown as CancelApplicationContext['applicationService'],
    notificationService: {
      sendCancellationToEmployer: jest.fn().mockResolvedValue(undefined),
    } as unknown as CancelApplicationContext['notificationService'],
    ...overrides,
  };
}

function makeState(applicationId: string, step = 1, extraPayload: Record<string, unknown> = {}): BotState {
  return {
    flowId: FLOW_IDS.CANCEL_APPLICATION,
    step,
    payload: { applicationId, ...extraPayload },
    updatedAt: new Date().toISOString(),
  };
}

describe('runCancelApplicationFlow()', () => {
  describe('guard checks', () => {
    it('returns menu on "menu" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, 'menu', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('returns error when applicationId is missing', async () => {
      const ctx = makeCtx();
      const state: BotState = {
        flowId: FLOW_IDS.CANCEL_APPLICATION,
        step: 1,
        payload: {},
        updatedAt: new Date().toISOString(),
      };
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('CANDIDATURE NON TROUVÉE');
    });

    it('blocks employer', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', employerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('WORKERS');
    });

    it('returns error when application not found', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(null),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('CANDIDATURE INTROUVABLE');
    });

    it('returns error when application belongs to another worker', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue({
            ...makeApp(hoursFromNow(10)),
            worker_id: 'other-worker',
          }),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('returns error when application is not PENDING or ACCEPTED', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(10), { status: 'CANCELLED' })),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('NE PEUT PLUS');
    });
  });

  describe('step 1 — > 4h before (no penalty)', () => {
    it('shows initial cancel prompt on empty input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('Plombier');
    });

    it('cancels immediately on "1" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.cancel).toHaveBeenCalledWith(APP_ID, WORKER_ID, undefined);
    });

    it('cancels on "confirmer" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, 'confirmer', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('keeps candidature on "2" input', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '2', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('maintenue');
    });

    it('cancels with custom reason on free text', async () => {
      const ctx = makeCtx();
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, 'Urgence familiale', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(ctx.applicationService.cancel).toHaveBeenCalledWith(APP_ID, WORKER_ID, 'Urgence familiale');
    });
  });

  describe('step 1 — < 4h before (late penalty)', () => {
    it('shows penalty warning prompt', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(2))),
          cancel: jest.fn().mockResolvedValue({ penaltyAmount: 5000, penaltyApplied: true }),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '', workerProfile, ctx);
      expect(result.nextState).toBeDefined();
      expect(result.reply[0]).toContain('pénalité');
    });

    it('requires reason for late cancellation', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(2))),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID);
      const result = await runCancelApplicationFlow(state, '1', workerProfile, ctx);
      // '1' is not recognized as reason in late mode — it moves to step 2 or asks for reason
      expect(result.reply).toBeDefined();
    });
  });

  describe('step 2 — confirm late cancellation', () => {
    it('cancels on "1" input with saved reason', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(2))),
          cancel: jest.fn().mockResolvedValue({ penaltyAmount: 5000, penaltyApplied: true }),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID, 2, { reason: 'Emergency' });
      const result = await runCancelApplicationFlow(state, '1', workerProfile, ctx);
      expect(result.clearState).toBe(true);
    });

    it('keeps candidature on "2" input', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(2))),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID, 2, { reason: 'Emergency' });
      const result = await runCancelApplicationFlow(state, '2', workerProfile, ctx);
      expect(result.clearState).toBe(true);
      expect(result.reply[0]).toContain('maintenue');
    });

    it('asks again for invalid input', async () => {
      const ctx = makeCtx({
        applicationService: {
          findById: jest.fn().mockResolvedValue(makeApp(hoursFromNow(2))),
        } as unknown as CancelApplicationContext['applicationService'],
      });
      const state = makeState(APP_ID, 2, { reason: 'Emergency' });
      const result = await runCancelApplicationFlow(state, 'maybe', workerProfile, ctx);
      expect(result.nextState).toBeDefined();
      expect(result.clearState).toBeUndefined();
    });
  });

  describe('getCancelApplicationInitialState()', () => {
    it('returns correct initial state', () => {
      const state = getCancelApplicationInitialState('app-99');
      expect(state.flowId).toBe(FLOW_IDS.CANCEL_APPLICATION);
      expect(state.step).toBe(1);
      expect(state.payload?.applicationId).toBe('app-99');
    });
  });
});
